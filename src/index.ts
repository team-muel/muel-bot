import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { config } from './config.js';
import {
  handleFlatSubscribeCommand,
  SUBSCRIBE_COMMAND_NAME,
} from './subscribe.js';
import {
  getYouTubeMonitorStatus,
} from './youtubeMonitor.js';
import { handleMuelMention, shouldMuelRespond } from './mentionHandler.js';
import { pushMessage } from './channelBuffer.js';
import { getJobWorkerStatus } from './jobWorker.js';
import { getSupabaseClient } from './supabase.js';
import { isNegativeEmoji, recordFeedbackSignal } from './feedbackSignals.js';
import { observeCommunityMessage } from './communityFlow.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import {
  handleHubSlashInteraction,
  handleHubChannelMessage,
  HUB_COMMAND_NAME,
} from './conciergeHandler.js';
import { isHubChannelActive } from './hubChannels.js';
import { handleResearchEnrichButton, isResearchEnrichButton, handleResearchDeepButton, isResearchDeepButton } from './researchEnrich.js';
import { handleMuelActionButton, isMuelActionButton } from './actionConfirmations.js';
import { handleMemoCommand, handleMemoSelectMenu, isMemoSelectMenu, MEMO_COMMAND_NAME } from './memoHandler.js';
import { ROLLING_COMMAND_NAME, handleRollingCommand, handleRollingButton, isRollingButton, handleRollingSelect, isRollingSelect } from './rollingPaperHandler.js';
import { handleMemoProposalButton, isMemoProposalButton } from './memoProposal.js';
import { WELCOME_COMMAND_NAME, handleWelcomeCommand, postWelcomeIfConfigured } from './welcomeHandler.js';
import { CODEX_COMMAND_NAME, handleCodexCommand, handleCodexSelect, isCodexSelect } from './gomdoriCodexHandler.js';
import {
  archiveMemberAdd,
  archiveMemberRemove,
  archiveMessageCreate,
  archiveMessageDelete,
  archiveMessageUpdate,
  getArchivistStatus,
} from './archivist/index.js';
import {
  ARCHIVE_POLICY_COMMAND_NAME,
  handleArchivePolicyCommand,
} from './archivist/policy.js';
import {
  getCommandRegistrationStatus,
  registerGomdoriCommands,
  registerMuelCommands,
} from './discordCommandRegistry.js';
import { getSupabaseRestrictionStatus } from './serviceRestriction.js';
import { startRuntimeHttpServer } from './runtimeHttpServer.js';
import { startRuntimeServices } from './runtimeServices.js';
import { observeDiscordConnection, usePublicDiscordGateway } from './discordConnection.js';

let readyAt: string | null = null;
let loginError: string | null = null;
let gomdoriReadyAt: string | null = null;
let gomdoriLoginError: string | null = null;

const getRuntimeStatus = () => {
  const youtubeMonitor = getYouTubeMonitorStatus();
  const jobWorker = getJobWorkerStatus();
  const commands = getCommandRegistrationStatus();
  const supabaseRestriction = getSupabaseRestrictionStatus();
  const degradedReasons: string[] = [];

  if (loginError) degradedReasons.push(`muel_login:${loginError}`);
  if (gomdoriClient && config.gomdoriBotToken && gomdoriLoginError) degradedReasons.push(`gomdori_login:${gomdoriLoginError}`);
  if (!client.isReady()) degradedReasons.push('muel_not_ready');
  if (gomdoriClient && !gomdoriClient.isReady()) degradedReasons.push('gomdori_not_ready');
  if (jobWorker.lastError) degradedReasons.push(`job_worker:${jobWorker.lastError}`);
  if (config.enableYoutubeMonitor && youtubeMonitor.lastTickStatus === 'error') degradedReasons.push(`youtube_monitor:${youtubeMonitor.lastTickMessage ?? 'unknown'}`);
  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) degradedReasons.push('llm_not_configured');
  if (commands.lastError) degradedReasons.push(`command_registration:${commands.lastError}`);
  if (supabaseRestriction.active) {
    degradedReasons.push(`supabase_data_api:${supabaseRestriction.reason ?? 'restricted'}`);
  }
  const archivist = getArchivistStatus();
  if (archivist.enabled && !archivist.ready) degradedReasons.push(`archivist:${archivist.lastError ?? 'not_ready'}`);

  return {
    ok: degradedReasons.length === 0,
    degradedReasons,
    youtubeMonitor,
    jobWorker,
    archivist,
    commands,
    supabaseRestriction,
  };
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // DM 채널의 메시지 이벤트를 받기 위해 필요. shouldMuelRespond / handleMuelMention
    // 는 이미 isDM 케이스를 처리 중 — intent 만 빠진 상태였음.
    GatewayIntentBits.DirectMessages,
    // 서버 신규 입장 멤버에게 환영 DM 을 보내기 위한 privileged intent.
    // Discord Developer Portal → Bot → Privileged Gateway Intents 에서
    // "SERVER MEMBERS INTENT" 활성화 필수. 100 서버 이상 되면 verification 필요.
    GatewayIntentBits.GuildMembers,
    // 부정 피드백 신호(👎 등 리액션) 수집용.
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  // 봇이 아직 캐시하지 않은 DM 채널의 messageCreate 이벤트를 partial 로라도 받기 위해 필요.
  // discord.js 의 표준 패턴 (DM 봇이 채널을 미리 알 길이 없음).
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

/**
 * 신규 멤버 환영 DM. Muel 페르소나 (반말 + 짧고 dense) 로 첫 인사 + 사용법.
 *
 * 부수 효과: 사용자 ↔ Muel DM 채널이 *처음 열린다*. 이후 봇 → 사용자 push (예:
 * AI-Q 리서치 리포트 DM 전송) 가 차단되지 않음.
 *
 * 사용자가 DM 막은 경우는 silent fail. 강제 못 함.
 */
const MUEL_WELCOME_DM = [
  '안녕, 나는 Muel (뮤엘) 이야.',
  '이 서버 어디서든 `@Muel` 멘션해서 부르거나, 여기 DM 으로도 바로 얘기할 수 있어.',
  '뭐든 질문해도 돼. 모르면 모른다고 할게.',
].join('\n');


const buildHelpMessage = () => renderDiscordMessage([{
  type: 'info-card',
  tone: 'muel',
  title: '명령어',
  body: [
    '/구독 - 유튜브 채널 구독 알림',
    '/메모 - 뮤엘에게 기억시키기',
    '/허브 - 이 채널에서 평소 대화에도 응답',
    '/롤링페이퍼 - 멤버끼리 한 줄 남기기',
    '/도움말 · /ping',
    '',
    `팀뮤엘: ${config.hubUrl}`,
    `기록: ${config.hubUrl}/weave`,
  ].join('\n'),
  footer: 'Muel은 AI이며 인물 등에 관한 정보 제공 시 실수를 할 수 있어요.',
}]);

client.once(Events.ClientReady, async (readyClient) => {
  readyAt = new Date().toISOString();
  console.log(`[discord] online as ${readyClient.user.tag}`);

  await startRuntimeServices(readyClient);

  if (config.registerDiscordCommandsOnReady) {
    try {
      await registerMuelCommands(readyClient);
    } catch (error) {
      loginError = error instanceof Error ? error.message : String(error);
      console.error('[discord] command registration failed', error);
    }
  } else {
    console.info('[discord] automatic command registration disabled');
  }
});

if (!config.enableHttpInteractions) {
  client.on(Events.InteractionCreate, async (interaction) => {
    // Button interactions (e.g., 'research:enrich:...' enrichment trigger).
    if (interaction.isButton()) {
      if (isResearchEnrichButton(interaction.customId)) {
        await handleResearchEnrichButton(client as Client<true>, interaction);
      } else if (isResearchDeepButton(interaction.customId)) {
        await handleResearchDeepButton(client as Client<true>, interaction);
      } else if (isMuelActionButton(interaction.customId)) {
        await handleMuelActionButton(getSupabaseClient(), interaction);
      } else if (isRollingButton(interaction.customId)) {
        await handleRollingButton(interaction);
      } else if (isMemoProposalButton(interaction.customId)) {
        await handleMemoProposalButton(interaction);
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (isMemoSelectMenu(interaction.customId)) {
        await handleMemoSelectMenu(interaction);
      } else if (isRollingSelect(interaction.customId)) {
        await handleRollingSelect(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: '응, 여기 있어.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (interaction.commandName === '도움말') {
      await interaction.reply({ ...buildHelpMessage(), flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (interaction.commandName === SUBSCRIBE_COMMAND_NAME) {
      try {
        await handleFlatSubscribeCommand(interaction);
      } catch (error) {
        console.error('[youtube-subscribe] interaction failed', {
          interactionId: interaction.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          error,
        });
        const fallback = { content: '구독 명령을 처리하지 못했어요. 잠시 뒤 다시 시도해주세요.' };
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(fallback);
          } else {
            await interaction.reply(interaction.inGuild()
              ? { ...fallback, flags: [MessageFlags.Ephemeral] }
              : fallback);
          }
        } catch (replyError) {
          console.error('[youtube-subscribe] fallback response failed', {
            interactionId: interaction.id,
            replyError,
          });
        }
      }
      return;
    }

    if (interaction.commandName === HUB_COMMAND_NAME) {
      await handleHubSlashInteraction(interaction);
      return;
    }

    if (interaction.commandName === MEMO_COMMAND_NAME) {
      await handleMemoCommand(interaction);
      return;
    }


    if (interaction.commandName === ROLLING_COMMAND_NAME) {
      await handleRollingCommand(interaction);
      return;
    }

    if (interaction.commandName === WELCOME_COMMAND_NAME) {
      await handleWelcomeCommand(interaction);
      return;
    }

    if (interaction.commandName === ARCHIVE_POLICY_COMMAND_NAME) {
      await handleArchivePolicyCommand(interaction);
      return;
    }

    await interaction.reply({
      ...renderDiscordMessage([{
        type: 'info-card',
        tone: 'warning',
        title: '알 수 없는 명령어',
        body: '내가 아는 명령은 /도움말 /구독 /메모 /허브 /ping 이야.',
      }]),
      flags: [MessageFlags.Ephemeral],
    });
  });
}

client.on(Events.MessageCreate, async (message) => {
  if (!client.isReady()) {
    return;
  }
  void archiveMessageCreate(message).catch((error) => {
    console.warn('[archivist] messageCreate failed', { messageId: message.id, error });
  });
  if (message.author.bot) {
    return;
  }

  let mentionPathHandled = false;
  try {
    mentionPathHandled = await shouldMuelRespond(message, client);
  } catch (error) {
    console.warn('[muel] shouldMuelRespond check failed', error);
  }

  if (mentionPathHandled) {
    await handleMuelMention(client, message);
  } else if (message.guildId && message.content) {
    try {
      const active = await isHubChannelActive(getSupabaseClient(), {
        guildId: message.guildId,
        channelId: message.channelId,
      });
      if (active) {
        await handleHubChannelMessage(client, message);
      }
    } catch (error) {
      console.warn('[hub] channel auto-respond failed', error);
    }
  }

  if (message.content) {
    pushMessage(message.channelId, {
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.displayName ?? message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
      replyToId: message.reference?.messageId ?? undefined,
    });
    try {
      observeCommunityMessage(getSupabaseClient(), message);
    } catch (error) {
      console.warn('[community-flow] skipped observe', error);
    }
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    await archiveMessageUpdate(oldMessage, newMessage);
  } catch (error) {
    console.warn('[archivist] messageUpdate failed', { messageId: newMessage.id, error });
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    await archiveMessageDelete(message);
  } catch (error) {
    console.warn('[archivist] messageDelete failed', { messageId: message.id, error });
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    const msg = reaction.message;
    if (msg.partial) {
      try { await msg.fetch(); } catch { return; }
    }
    if (!client.user || msg.author?.id !== client.user.id) return; // Muel 자기 메시지에 달린 리액션만
    if (!isNegativeEmoji(reaction.emoji.name)) return;
    await recordFeedbackSignal(getSupabaseClient(), {
      signalType: 'reaction_negative',
      sentiment: 'negative',
      guildId: msg.guildId ?? null,
      channelId: msg.channelId,
      channelType: msg.guildId ? 'guild' : 'dm',
      muelMessageId: msg.id,
      userId: user.id,
      severity: 2,
      evidence: `reaction:${reaction.emoji.name ?? '?'}`,
      metadata: { emoji: reaction.emoji.name },
    });
  } catch (err) {
    console.warn('[feedback-signal] reaction handler failed', err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await archiveMemberAdd(member);
  } catch (error) {
    console.warn('[archivist] guildMemberAdd restore failed', { userId: member.id, error });
  }
  if (member.user.bot) return;
  try {
    await member.send(MUEL_WELCOME_DM);
    console.log('[muel-welcome] sent', { userId: member.id, guildId: member.guild.id });
  } catch (err) {
    // 사용자가 *서버 멤버의 DM 허용 X* 또는 봇 차단. 강제 못 함, silent.
    console.warn('[muel-welcome] DM blocked', {
      userId: member.id,
      guildId: member.guild.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  await postWelcomeIfConfigured(member);
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await archiveMemberRemove(member);
  } catch (error) {
    console.warn('[archivist] guildMemberRemove mask failed', { userId: member.id, error });
  }
});

client.on(Events.Error, (error) => {
  console.error('[discord] client error', error);
});

// --- Gomdori client (optional) ---

const gomdoriClient = config.gomdoriBotToken
  ? new Client({ intents: [GatewayIntentBits.Guilds] })
  : null;

if (gomdoriClient) {
  // /게임 은 Discord Activity entry point command (type=4, handler=2) 하나로만 등록.
  // 같은 이름의 chat input command (type=1) 를 동시에 등록하면 Discord 가
  // 둘 중 하나로 덮어쓰기 때문에 entry point 만 남긴다. 클릭 시 Discord 가
  // 자동으로 muel-tree /game Activity 를 띄운다 — 봇 인터랙션 핸들러는
  // /게임 에 대해 받지 않는다.
  gomdoriClient.once(Events.ClientReady, async (readyGomdori) => {
    gomdoriReadyAt = new Date().toISOString();
    console.log(`[gomdori] online as ${readyGomdori.user.tag}`);

    if (config.registerDiscordCommandsOnReady) {
      try {
        await registerGomdoriCommands(readyGomdori, config.gomdoriBotToken!);
        console.log('[gomdori] replaced global commands');
      } catch (error) {
        gomdoriLoginError = error instanceof Error ? error.message : String(error);
        console.error('[gomdori] command registration failed', error);
      }
    } else {
      console.info('[gomdori] automatic command registration disabled');
    }
  });

  if (!config.enableHttpInteractions) {
    gomdoriClient.on(Events.InteractionCreate, async (interaction) => {
      // 도감 자세히 보기(드롭다운) — chat input 보다 먼저 라우팅.
      if (interaction.isStringSelectMenu()) {
        if (isCodexSelect(interaction.customId)) {
          await handleCodexSelect(interaction);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'ping') {
        await interaction.reply({ content: 'pong 🐻', flags: [MessageFlags.Ephemeral] });
        return;
      }
      if (interaction.commandName === CODEX_COMMAND_NAME) {
        await handleCodexCommand(interaction);
        return;
      }
      // /게임 은 entry point command 라 핸들러를 거치지 않는다.
    });
  }

  gomdoriClient.on(Events.Error, (error) => {
    console.error('[gomdori] client error', error);
  });
}

startRuntimeHttpServer({
  client,
  gomdoriClient,
  getRuntimeStatus,
  getMuelConnectionStatus: () => ({ readyAt, loginError }),
  getGomdoriConnectionStatus: () => ({
    readyAt: gomdoriReadyAt,
    loginError: gomdoriLoginError,
  }),
});

// --- Login ---

usePublicDiscordGateway(client, 'muel');
observeDiscordConnection(client, 'muel');
client.login(config.discordBotToken).catch((error: unknown) => {
  loginError = error instanceof Error ? error.message : String(error);
  console.error('[discord] login failed', error);
});

if (gomdoriClient && config.gomdoriBotToken) {
  usePublicDiscordGateway(gomdoriClient, 'gomdori');
  observeDiscordConnection(gomdoriClient, 'gomdori');
  gomdoriClient.login(config.gomdoriBotToken).catch((error: unknown) => {
    gomdoriLoginError = error instanceof Error ? error.message : String(error);
    console.error('[gomdori] login failed', error);
  });
}

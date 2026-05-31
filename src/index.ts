import http from 'node:http';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import {
  handleFlatSubscribeCommand,
  OPTION_ACTION,
  OPTION_KIND,
  OPTION_LINK,
  SUBSCRIBE_ACTION_ADD,
  SUBSCRIBE_ACTION_LIST,
  SUBSCRIBE_ACTION_REMOVE,
  SUBSCRIBE_COMMAND_NAME,
} from './subscribe.js';
import { getYouTubeMonitorStatus, startYouTubeMonitor } from './youtubeMonitor.js';
import { handleDiscordInteractions } from './discordInteractions.js';
import { handleMuelMention, shouldMuelRespond } from './mentionHandler.js';
import { pushMessage } from './channelBuffer.js';
import { configureJobWorker, getJobWorkerStatus, runJobWorkerLoop } from './jobWorker.js';
import { getSupabaseClient } from './supabase.js';
import { observeCommunityMessage } from './communityFlow.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import {
  buildHubSlashCommand,
  handleHubSlashInteraction,
  handleHubChannelMessage,
  HUB_COMMAND_NAME,
} from './conciergeHandler.js';
import { isHubChannelActive, getHubChannelStatus } from './hubChannels.js';
import { handleResearchEnrichButton, isResearchEnrichButton, handleResearchDeepButton, isResearchDeepButton } from './researchEnrich.js';

let readyAt: string | null = null;
let loginError: string | null = null;
let gomdoriReadyAt: string | null = null;
let gomdoriLoginError: string | null = null;

let lastRegisteredAt: string | null = null;
let lastRegisteredCommandNames: string[] = [];
let lastRegistrationError: string | null = null;
let lastLegacyGuildCommandCleanupAt: string | null = null;
let lastLegacyGuildCommandCleanupNames: string[] = [];

const getRuntimeStatus = () => {
  const youtubeMonitor = getYouTubeMonitorStatus();
  const jobWorker = getJobWorkerStatus();
  const degradedReasons: string[] = [];

  if (loginError) degradedReasons.push(`muel_login:${loginError}`);
  if (gomdoriClient && config.gomdoriBotToken && gomdoriLoginError) degradedReasons.push(`gomdori_login:${gomdoriLoginError}`);
  if (!client.isReady()) degradedReasons.push('muel_not_ready');
  if (jobWorker.lastError) degradedReasons.push(`job_worker:${jobWorker.lastError}`);
  if (config.enableYoutubeMonitor && youtubeMonitor.lastTickStatus === 'error') degradedReasons.push(`youtube_monitor:${youtubeMonitor.lastTickMessage ?? 'unknown'}`);
  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) degradedReasons.push('llm_not_configured');
  if (lastRegistrationError) degradedReasons.push(`command_registration:${lastRegistrationError}`);

  return {
    ok: degradedReasons.length === 0,
    degradedReasons,
    youtubeMonitor,
    jobWorker,
  };
};

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const helpCommand = new SlashCommandBuilder()
  .setName('도움말')
  .setDescription('Muel에서 사용할 수 있는 입구를 안내합니다.');

const diaryEntryPointCommand = {
  name: '일기',
  description: '꿈을 기록하고 연결합니다.',
  type: 4,
  handler: 2,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const subscribeCommand = new SlashCommandBuilder()
  .setName(SUBSCRIBE_COMMAND_NAME)
  .setDescription('영상/게시글/뉴스 자동 구독을 관리합니다.')
  .addStringOption((option) =>
    option
      .setName(OPTION_ACTION)
      .setDescription('조회 / 추가 / 제거')
      .setRequired(true)
      .addChoices(
        { name: '조회', value: SUBSCRIBE_ACTION_LIST },
        { name: '추가', value: SUBSCRIBE_ACTION_ADD },
        { name: '제거', value: SUBSCRIBE_ACTION_REMOVE },
      ),
  )
  .addStringOption((option) =>
    option
      .setName(OPTION_KIND)
      .setDescription('영상 또는 게시글')
      .setRequired(false)
      .addChoices(
        { name: '영상', value: 'videos' },
        { name: '게시글', value: 'posts' },
      ),
  )
  .addStringOption((option) =>
    option
      .setName(OPTION_LINK)
      .setDescription('YouTube 채널 링크 또는 UC 채널 ID')
      .setRequired(false),
  );

const LEGACY_GUILD_HUB_COMMAND_NAMES = new Set([
  '허브활성화',
  '허브비활성화',
  '허브목록',
  '허브상태',
  '허브-활성화',
  '허브-비활성화',
  '허브-목록',
  '허브-상태',
  '허브_활성화',
  '허브_비활성화',
  '허브_목록',
  '허브_상태',
  'hub-activate',
  'hub-deactivate',
  'hub-list',
  'hub-status',
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const cleanupLegacyGuildCommands = async (readyClient: Client<true>, rest: REST): Promise<void> => {
  const cleanedNames: string[] = [];
  const guilds = [...readyClient.guilds.cache.values()];

  for (const guild of guilds) {
    try {
      const rows = await rest.get(Routes.applicationGuildCommands(readyClient.application.id, guild.id));
      if (!Array.isArray(rows)) continue;

      for (const row of rows as Array<{ id?: string; name?: string }>) {
        if (!row.id || !row.name || !LEGACY_GUILD_HUB_COMMAND_NAMES.has(row.name)) continue;
        await rest.delete(Routes.applicationGuildCommand(readyClient.application.id, guild.id, row.id));
        cleanedNames.push(`${guild.id}:${row.name}`);
      }
    } catch (error) {
      console.warn('[discord] legacy guild command cleanup failed', {
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (cleanedNames.length > 0) {
    lastLegacyGuildCommandCleanupAt = new Date().toISOString();
    lastLegacyGuildCommandCleanupNames = cleanedNames;
    console.log('[discord] cleaned legacy guild commands', { count: cleanedNames.length, names: cleanedNames });
  }
};

const registerCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands: any[] = [
    helpCommand.toJSON(),
    subscribeCommand.toJSON(),
    pingCommand.toJSON(),
    diaryEntryPointCommand,
    buildHubSlashCommand(),
  ];

  const intendedNames = commands.map((c: any) => c.name);
  console.log('[discord] registering global commands', { count: commands.length, names: intendedNames });

  try {
    const result = await rest.put(Routes.applicationCommands(readyClient.application.id), {
      body: commands,
    });
    const registeredNames = Array.isArray(result)
      ? (result as Array<{ name?: string }>).map((row) => row?.name ?? '?').filter(Boolean)
      : [];
    lastRegisteredAt = new Date().toISOString();
    lastRegisteredCommandNames = registeredNames.length > 0 ? registeredNames : intendedNames;
    lastRegistrationError = null;
    console.log('[discord] replaced global commands', {
      attempted: intendedNames,
      registered: registeredNames,
      note: 'Discord 글로벌 명령은 client UI 캐시 갱신에 최대 1시간까지 걸릴 수 있음',
    });
    await cleanupLegacyGuildCommands(readyClient, rest);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const responseBody = (error as { rawError?: unknown }).rawError;
    lastRegistrationError = detail;
    console.error('[discord] command registration failed', {
      attempted: intendedNames,
      detail,
      responseBody,
    });
    throw error;
  }
};

const buildHelpMessage = () => renderDiscordMessage([{
  type: 'info-card',
  tone: 'muel',
  title: 'Muel',
  body: '커뮤니티 안에 상주하면서 대화, 외부 피드 큐레이션, 기억 파이프라인, Weave 연결을 맡습니다. Gomdori는 별도의 게임/Activity 실행체입니다.',
  fields: [
    {
      name: '명령어',
      value: [
        '/구독 - YouTube 영상/게시글 자동 구독 관리',
        '/허브 - 이 채널에서 뮤엘이 자연어로 응답할지 켜고 끄기 (채널 관리 권한 필요)',
        '/도움말 - 이 안내 보기',
        '/ping - 온라인 확인',
      ].join('\n'),
    },
    {
      name: 'Activity',
      value: [
        `일기: ${config.hubUrl}/weave`,
        `Gomdori 게임: ${config.hubUrl}/game`,
      ].join('\n'),
    },
  ],
  footer: 'Muel = community AI / Gomdori = game Activity',
}]);

client.once(Events.ClientReady, async (readyClient) => {
  readyAt = new Date().toISOString();
  console.log(`[discord] online as ${readyClient.user.tag}`);
  configureJobWorker(readyClient);

  try {
    await registerCommands(readyClient);
  } catch (error) {
    loginError = error instanceof Error ? error.message : String(error);
    console.error('[discord] command registration failed', error);
  }

  if (config.enableYoutubeMonitor) {
    startYouTubeMonitor(readyClient);
  }

  if (config.enableJobWorker) {
    runJobWorkerLoop().catch(err => {
      console.error('[jobs] worker loop crashed', err);
    });
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
      }
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'pong', flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (interaction.commandName === '도움말') {
      await interaction.reply({ ...buildHelpMessage(), flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (interaction.commandName === SUBSCRIBE_COMMAND_NAME) {
      await handleFlatSubscribeCommand(interaction);
      return;
    }

    if (interaction.commandName === HUB_COMMAND_NAME) {
      await handleHubSlashInteraction(interaction);
      return;
    }

    await interaction.reply({
      ...renderDiscordMessage([{
        type: 'info-card',
        tone: 'warning',
        title: '알 수 없는 명령어',
        body: '지금 사용할 수 있는 명령어는 /도움말, /구독, /허브, /ping 입니다.',
      }]),
      flags: [MessageFlags.Ephemeral],
    });
  });
}

client.on(Events.MessageCreate, async (message) => {
  if (!client.isReady()) {
    return;
  }
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
      authorId: message.author.id,
      authorName: message.author.displayName ?? message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
    });
    try {
      observeCommunityMessage(getSupabaseClient(), message);
    } catch (error) {
      console.warn('[community-flow] skipped observe', error);
    }
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
  const gomdoriPingCommand = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether Gomdori Bot is online.');

  const gomdoriActivityEntryPointCommand = {
    name: '게임',
    description: 'Gomdori 게임을 시작합니다.',
    type: 4,
    handler: 2,
    integration_types: [0, 1],
    contexts: [0, 1, 2],
  };

  gomdoriClient.once(Events.ClientReady, async (readyGomdori) => {
    gomdoriReadyAt = new Date().toISOString();
    console.log(`[gomdori] online as ${readyGomdori.user.tag}`);

    try {
      const rest = new REST({ version: '10' }).setToken(config.gomdoriBotToken!);
      await rest.put(Routes.applicationCommands(readyGomdori.application.id), {
        body: [
          gomdoriPingCommand.toJSON(),
          gomdoriActivityEntryPointCommand,
        ],
      });
      console.log('[gomdori] replaced global commands');
    } catch (error) {
      gomdoriLoginError = error instanceof Error ? error.message : String(error);
      console.error('[gomdori] command registration failed', error);
    }
  });

  if (!config.enableHttpInteractions) {
    gomdoriClient.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'ping') {
        await interaction.reply({ content: 'pong 🐻', flags: [MessageFlags.Ephemeral] });
        return;
      }
      // /게임 은 entry point command 라 핸들러를 거치지 않는다.
    });
  }

  gomdoriClient.on(Events.Error, (error) => {
    console.error('[gomdori] client error', error);
  });
}

// --- HTTP server ---

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('OK');
    return;
  }

  if (request.url === '/ready') {
    const runtime = getRuntimeStatus();
    response.writeHead(runtime.ok ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(runtime));
    return;
  }

  if (request.url === '/discord/interactions' && request.method === 'POST') {
    void handleDiscordInteractions(request, response);
    return;
  }

  if (request.url?.startsWith('/admin/reregister-commands') && request.method === 'POST') {
    void (async () => {
      const adminToken = process.env.MUEL_ADMIN_TOKEN?.trim();
      const urlObj = new URL(request.url ?? '/', 'http://localhost');
      const provided = urlObj.searchParams.get('token');
      if (!adminToken || provided !== adminToken) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      if (!client.isReady()) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'client not ready' }));
        return;
      }
      try {
        await registerCommands(client as Client<true>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          lastRegisteredAt,
          lastRegisteredCommandNames,
        }));
      } catch (err) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
    return;
  }

  const runtime = getRuntimeStatus();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ok: runtime.ok,
    degradedReasons: runtime.degradedReasons,
    muel: {
      bot: client.user?.tag ?? null,
      readyAt,
      loginError,
      wsStatus: client.ws.status,
      ai: {
        primaryProvider: config.googleGenerativeAiApiKey ? 'gemini' : config.nvidiaApiKey ? 'nvidia' : null,
        geminiConfigured: Boolean(config.googleGenerativeAiApiKey),
        geminiModel: config.muelAiModel,
        nvidiaConfigured: Boolean(config.nvidiaApiKey),
        nvidiaModel: config.nvidiaModel,
      },
    },
    gomdori: gomdoriClient
      ? {
          bot: gomdoriClient.user?.tag ?? null,
          readyAt: gomdoriReadyAt,
          loginError: gomdoriLoginError,
          wsStatus: gomdoriClient.ws.status,
        }
      : null,
    uptimeSeconds: Math.floor(process.uptime()),
    youtubeMonitor: runtime.youtubeMonitor,
    jobWorker: runtime.jobWorker,
    runtime: {
      enableJobWorker: config.enableJobWorker,
      enableYoutubeMonitor: config.enableYoutubeMonitor,
      mentionReplyTimeoutMs: config.mentionReplyTimeoutMs,
      enableHttpInteractions: config.enableHttpInteractions,
    },
    hub: getHubChannelStatus(),
    commands: {
      lastRegisteredAt,
      registered: lastRegisteredCommandNames,
      lastError: lastRegistrationError,
      legacyGuildCleanup: {
        lastCleanedAt: lastLegacyGuildCommandCleanupAt,
        cleaned: lastLegacyGuildCommandCleanupNames,
      },
    },
  }));
});

server.listen(config.port, () => {
  console.log(`[http] listening on ${config.port}`);
});

// --- Login ---

client.login(config.discordBotToken).catch((error: unknown) => {
  loginError = error instanceof Error ? error.message : String(error);
  console.error('[discord] login failed', error);
});

if (gomdoriClient && config.gomdoriBotToken) {
  gomdoriClient.login(config.gomdoriBotToken).catch((error: unknown) => {
    gomdoriLoginError = error instanceof Error ? error.message : String(error);
    console.error('[gomdori] login failed', error);
  });
}

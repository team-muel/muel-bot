import crypto from 'node:crypto';
import type { ChatInputCommandInteraction, Client, Message } from 'discord.js';
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { prepareChatTurn, getUserHistorySummary } from './muelConversationStore.js';
import { upsertDiscordMuelProfile } from './muelProfiles.js';
import { generateMuelReply, toDiscordReply } from './muelAgent.js';
import { formatForContext } from './channelBuffer.js';
import { formatGuildTopology } from './guildTopology.js';
import { config } from './config.js';
import { logMuelAiEvent } from './muelAiEvents.js';
import { classifyMentionIntent, type MuelRouterIntent } from './muelRouter.js';
import { acquireMentionSlot } from './mentionRateLimit.js';
import { logMuelAgentAction } from './agentActions.js';
import { REACTION_DONE, REACTION_QUESTION, REACTION_SEEN, tagMessage } from './agentReactions.js';
import {
  activateHubChannel,
  deactivateHubChannel,
  isHubChannelActive,
  getHubChannelConfig,
  listHubChannels,
} from './hubChannels.js';

/**
 * Concierge entry points.
 *
 *   1. /허브 slash command (subcommands 활성화 / 비활성화 / 목록 / 상태) — config
 *      only, no LLM call. Default-member-permissions = ManageChannels.
 *
 *   2. handleHubChannelMessage — fires on plain (non-mention) messages in a
 *      hub-activated channel. Always runs the router classifier first and
 *      only proceeds to the chat lane when intent ∈ RESPONSIVE_INTENTS with
 *      confidence ≥ the channel's responsive_confidence_min (configured per
 *      channel; default 0.6). Non-responsive intents are logged as
 *      muel_agent_actions(status='denied'), no Discord reply.
 *
 * Write tools and reaction triggers stay out of scope.
 */

export const HUB_COMMAND_NAME = '허브';
const HUB_SUB_ACTIVATE = '활성화';
const HUB_SUB_DEACTIVATE = '비활성화';
const HUB_SUB_LIST = '목록';
const HUB_SUB_STATUS = '상태';
const HUB_SUB_FULL = '100';

const RESPONSIVE_INTENTS = new Set<MuelRouterIntent>([
  'cs_help',
  'news_query',
  'memory_query',
  'meta',
]);

// PA-0: a bare YouTube/link share gets classified as news_query but should NOT
// trigger a reflexive reply — only engage news_query when it reads as a question.
const looksLikeNewsQuestion = (text: string): boolean => {
  if (/[?？]/.test(text)) return true;
  return /(뭐|무슨|어때|어떤|추천|있어|있나|알려|찾아|봤|뉴스|소식|영상|업로드|recommend|news)/i.test(text);
};

const pickStringField = (record: Record<string, unknown> | undefined, key: string): string | null => {
  if (!record) return null;
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
};

const pickNumberField = (record: Record<string, unknown> | undefined, key: string): number | null => {
  if (!record) return null;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};

export const buildHubSlashCommand = () =>
  new SlashCommandBuilder()
    .setName(HUB_COMMAND_NAME)
    .setDescription('뮤엘 등장 — 이 채널 평소 대화에도 내가 끼게 할지 정해.')
    .addStringOption((opt) =>
      opt
        .setName('동작')
        .setDescription('활성화 / 100% / 비활성화 / 목록 / 상태')
        .setRequired(true)
        .addChoices(
          { name: '활성화 (평소 대화에 응답)', value: HUB_SUB_ACTIVATE },
          { name: '100% (응답 + 가끔 먼저 말 걸기)', value: HUB_SUB_FULL },
          { name: '비활성화', value: HUB_SUB_DEACTIVATE },
          { name: '목록', value: HUB_SUB_LIST },
          { name: '상태', value: HUB_SUB_STATUS },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON();

export const handleHubSlashInteraction = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  if (!guildId) {
    await interaction.editReply({
      content: '서버 안에서만 쓸 수 있어.',
    }).catch(() => {});
    return;
  }

  // Defense in depth — Discord hides the command from users without
  // ManageChannels via setDefaultMemberPermissions, but the cache can lag.
  const hasPermission = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;
  if (!hasPermission) {
    await interaction.editReply({
      content: '이 명령은 채널 관리 권한이 있는 사용자만 쓸 수 있어.',
    }).catch(() => {});
    void logMuelAgentAction(supabase, {
      triggerSource: 'slash_command',
      triggerDetail: `hub_${interaction.options.getString('동작', false) ?? 'unknown'}_denied`,
      status: 'denied',
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: interaction.user.id,
      metadata: { reason: 'missing_manage_channels' },
    });
    return;
  }

  const subcommand = interaction.options.getString('동작', true);

  if (subcommand === HUB_SUB_ACTIVATE || subcommand === HUB_SUB_FULL) {
    const full = subcommand === HUB_SUB_FULL;
    try {
      await activateHubChannel(supabase, {
        guildId,
        channelId,
        activatedByUserId: interaction.user.id,
        activatedByUsername: interaction.user.username,
      });
      await supabase.from('muel_proactive_configs').upsert(
        full
          ? { guild_id: guildId, channel_id: channelId, enabled: true, morning: true, spike: true }
          : { guild_id: guildId, channel_id: channelId, enabled: false },
        { onConflict: 'guild_id,channel_id' },
      );
      await interaction.editReply({
        content: full
          ? '좋아, 여기선 평소 대화에도 끼고 가끔 먼저도 말 걸게 (100%). 줄이려면 `/허브 동작:활성화`, 끄려면 `/허브 동작:비활성화`.'
          : '좋아, 이 채널에선 나도 평소처럼 떠들게. 먼저도 말 걸게 하려면 `/허브 동작:100%`, 끄려면 `/허브 동작:비활성화`.',
      });
      void logMuelAgentAction(supabase, {
        triggerSource: 'slash_command',
        triggerDetail: full ? 'hub_activate_full' : 'hub_activate',
        status: 'responded',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: interaction.user.id,
        metadata: { username: interaction.user.username, full },
      });
    } catch (error) {
      console.error('[hub] activate failed', error);
      await interaction.editReply({
        content: '허브 활성화에 실패했어. 잠시 뒤 다시 시도해줘.',
      }).catch(() => {});
      void logMuelAgentAction(supabase, {
        triggerSource: 'slash_command',
        triggerDetail: 'hub_activate',
        status: 'error',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: interaction.user.id,
        metadata: { errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) },
      });
    }
    return;
  }

  if (subcommand === HUB_SUB_DEACTIVATE) {
    try {
      await deactivateHubChannel(supabase, { guildId, channelId });
      await supabase.from('muel_proactive_configs').upsert(
        { guild_id: guildId, channel_id: channelId, enabled: false },
        { onConflict: 'guild_id,channel_id' },
      );
      await interaction.editReply({
        content: '이 채널의 뮤엘 허브를 껐어. 다시 켜려면 `/허브 동작:활성화`.',
      });
      void logMuelAgentAction(supabase, {
        triggerSource: 'slash_command',
        triggerDetail: 'hub_deactivate',
        status: 'responded',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: interaction.user.id,
      });
    } catch (error) {
      console.error('[hub] deactivate failed', error);
      await interaction.editReply({
        content: '허브 비활성화에 실패했어. 잠시 뒤 다시 시도해줘.',
      }).catch(() => {});
      void logMuelAgentAction(supabase, {
        triggerSource: 'slash_command',
        triggerDetail: 'hub_deactivate',
        status: 'error',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: interaction.user.id,
        metadata: { errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) },
      });
    }
    return;
  }

  if (subcommand === HUB_SUB_LIST) {
    try {
      const channels = await listHubChannels(supabase, { guildId });
      if (channels.length === 0) {
        await interaction.editReply({
          content: '이 서버에 활성화된 허브 채널이 없어.',
        }).catch(() => {});
        return;
      }
      const lines = channels.map((row) => {
        const conf = row.responsiveConfidenceMin.toFixed(2);
        const who = row.activatedByUsername ? ` (by ${row.activatedByUsername})` : '';
        return `- <#${row.channelId}> · 응답 임계값 ${conf}${who}`;
      });
      await interaction.editReply({
        content: [
          `활성 허브 채널 ${channels.length}개:`,
          ...lines,
        ].join('\n'),
        allowedMentions: { parse: [] },
      }).catch(() => {});
      void logMuelAgentAction(supabase, {
        triggerSource: 'slash_command',
        triggerDetail: 'hub_list',
        status: 'responded',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: interaction.user.id,
        metadata: { count: channels.length },
      });
    } catch (error) {
      console.error('[hub] list failed', error);
      await interaction.editReply({
        content: '허브 목록 조회에 실패했어.',
      }).catch(() => {});
    }
    return;
  }


  if (subcommand === HUB_SUB_STATUS) {
    const active = await isHubChannelActive(supabase, { guildId, channelId }).catch(() => false);
    const { data: pro } = await supabase
      .from('muel_proactive_configs')
      .select('enabled')
      .eq('guild_id', guildId)
      .eq('channel_id', channelId)
      .maybeSingle();
    const proactiveOn = !!(pro as { enabled?: boolean } | null)?.enabled;
    await interaction.editReply({
      content: !active
        ? '여긴 꺼져 있어 — 멘션해야 대답해. 켜려면 `/허브 동작:활성화`, 먼저 말도 걸게 하려면 `/허브 동작:100%`.'
        : proactiveOn
          ? '현재: 100% (응답 + 먼저 말 걸기). 줄이려면 `/허브 동작:활성화`.'
          : '현재: 활성화 (응답만). 먼저도 말 걸게 하려면 `/허브 동작:100%`.',
    }).catch(() => {});
    return;
  }
};

export const handleHubChannelMessage = async (
  client: Client<true>,
  message: Message,
): Promise<void> => {
  if (message.author.bot) return;
  if (!message.guildId) return;
  const userText = message.content?.trim() ?? '';
  const imageParts = [...message.attachments.values()]
    .filter((a) => (a.contentType ?? '').startsWith('image/'))
    .slice(0, 4)
    .map((a) => ({ type: 'image' as const, image: a.url }));
  if (!userText) return;

  const supabase = getSupabaseClient();
  const userId = message.author.id;
  const channelId = message.channelId;
  const guildId = message.guildId;
  const authorName = message.author.displayName ?? message.author.username;
  const startedAt = Date.now();

  const channelConfig = await getHubChannelConfig(supabase, { guildId, channelId }).catch(() => null);
  const responsiveMin = channelConfig?.responsiveConfidenceMin ?? 0.6;

  // Rate limit — same buckets as the mention path so abuse can't shift channels.
  const limitDecision = acquireMentionSlot({ userId, channelId });
  if (!limitDecision.allowed) {
    // Quiet rate-limit on the channel path: no reply (avoid Discord noise),
    // but record the denial for observability.
    void logMuelAgentAction(supabase, {
      triggerSource: 'allowlist_channel',
      triggerDetail: 'rate_limit',
      status: 'rate_limited',
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: userId,
      targetMessageId: message.id,
      metadata: { reason: limitDecision.reason },
    });
    return;
  }

  try {
    // Router gate — non-responsive intents drop without reply.
    const decision = await classifyMentionIntent(supabase, {
      chatId: null,
      userText,
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: userId,
    });

    const newsReflexSuppressed =
      decision?.intent === 'news_query' && !looksLikeNewsQuestion(userText);
    if (
      !decision ||
      !RESPONSIVE_INTENTS.has(decision.intent) ||
      decision.confidence < responsiveMin ||
      newsReflexSuppressed
    ) {
      void logMuelAgentAction(supabase, {
        triggerSource: 'allowlist_channel',
        triggerDetail: decision?.intent ?? 'router_unavailable',
        status: 'denied',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: userId,
        targetMessageId: message.id,
        metadata: {
          confidence: decision?.confidence ?? null,
          intent: decision?.intent ?? null,
          channelResponsiveMin: responsiveMin,
          reason: newsReflexSuppressed ? 'news_query_link_share_suppressed' : 'intent_not_responsive_or_low_confidence',
        },
      });
      return;
    }

    void tagMessage(message, REACTION_SEEN);
    if (decision.intent === 'cs_help' || decision.intent === 'memory_query') {
      void tagMessage(message, REACTION_QUESTION);
    }

    void upsertDiscordMuelProfile(supabase, message.author).catch((profileError) => {
      console.warn('[hub] profile upsert failed', profileError);
    });

    const userMessageId = crypto.randomUUID();
    const prepared = await prepareChatTurn(supabase, {
      source: 'discord_hub',
      sourceChannelId: channelId,
      sourceThreadId: channelId,
      userMessageId,
      userParts: [{ type: 'text', text: userText }, ...imageParts],
      metadata: {
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordMessageId: message.id,
        discordUserId: userId,
        discordUsername: message.author.username,
        externalMessageId: message.id,
        triggerSource: 'allowlist_channel',
        routerIntent: decision.intent,
        routerConfidence: decision.confidence,
        channelResponsiveMin: responsiveMin,
      },
    });
    const chatId = prepared.chatId;
    const history = prepared.messages;

    const userHistory = await getUserHistorySummary(supabase, userId).catch(() => null);
    const channelActivity = formatForContext(channelId, client.user.id, 6);
    const guildTopology = message.guild ? formatGuildTopology(message.guild) : '';

    const typingChannel = message.channel as { sendTyping?: () => Promise<void> };
    if (typeof typingChannel.sendTyping === 'function') {
      await typingChannel.sendTyping().catch(() => {});
    }

    const reply = await Promise.race([
      generateMuelReply(
        supabase,
        chatId,
        userText,
        authorName,
        history,
        guildId,
        [userId],
        channelActivity,
        userHistory,
        [],
        guildTopology,
        userId,
        channelId,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`hub generateMuelReply timed out after ${config.mentionReplyTimeoutMs}ms`)), config.mentionReplyTimeoutMs),
      ),
    ]);

    const sent = await message.reply({
      content: toDiscordReply(reply.text),
      allowedMentions: { parse: [], repliedUser: false },
    }).catch((err) => {
      console.warn('[hub] message.reply failed', err);
      return null;
    });

    if (sent) void tagMessage(message, REACTION_DONE);

    const meta = (reply.metadata ?? {}) as Record<string, unknown>;
    const taskType = pickStringField(meta, 'taskType') ?? 'chat';
    const modelLane = pickStringField(meta, 'modelLane') ?? 'chat';
    const fallbackReason = pickStringField(meta, 'fallbackReason');
    const inputTokens = pickNumberField(meta, 'inputTokens');
    const outputTokens = pickNumberField(meta, 'outputTokens');
    const totalTokens = pickNumberField(meta, 'totalTokens');

    const aiEventId = await logMuelAiEvent(supabase, {
      source: 'discord_hub',
      status: reply.provider === 'none' ? 'fallback' : fallbackReason ? 'fallback' : 'success',
      chatId,
      messageId: userMessageId,
      responseMessageId: sent?.id ?? null,
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: userId,
      provider: reply.provider,
      model: reply.model,
      latencyMs: Date.now() - startedAt,
      taskType,
      modelLane,
      fallbackReason,
      inputTokens,
      outputTokens,
      totalTokens,
      metadata: {
        triggerSource: 'allowlist_channel',
        routerIntent: decision.intent,
        routerConfidence: decision.confidence,
        channelResponsiveMin: responsiveMin,
        discordMessageId: message.id,
      },
    });

    void logMuelAgentAction(supabase, {
      triggerSource: 'allowlist_channel',
      triggerDetail: decision.intent,
      status: 'responded',
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: userId,
      targetMessageId: message.id,
      responseMessageId: sent?.id ?? null,
      aiEventId,
      metadata: {
        provider: reply.provider,
        model: reply.model,
        latencyMs: Date.now() - startedAt,
        routerConfidence: decision.confidence,
        channelResponsiveMin: responsiveMin,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[hub] channel message handling failed', error);

    const aiEventId = await logMuelAiEvent(supabase, {
      source: 'discord_hub',
      status: 'error',
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: userId,
      latencyMs: Date.now() - startedAt,
      taskType: 'chat',
      modelLane: 'chat',
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: reason,
      metadata: { triggerSource: 'allowlist_channel', discordMessageId: message.id },
    });

    void logMuelAgentAction(supabase, {
      triggerSource: 'allowlist_channel',
      triggerDetail: 'error',
      status: 'error',
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: userId,
      targetMessageId: message.id,
      aiEventId,
      metadata: { errorMessage: reason.slice(0, 240) },
    });
  } finally {
    limitDecision.release();
  }
};

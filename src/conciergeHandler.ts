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

const RESPONSIVE_INTENTS = new Set<MuelRouterIntent>([
  'cs_help',
  'news_query',
  'memory_query',
  'meta',
]);

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
    .setDescription('이 채널에서 뮤엘이 자연어로 응답할지 관리합니다.')
    .addSubcommand((sub) =>
      sub.setName(HUB_SUB_ACTIVATE).setDescription('이 채널을 뮤엘 허브로 활성화합니다.'),
    )
    .addSubcommand((sub) =>
      sub.setName(HUB_SUB_DEACTIVATE).setDescription('이 채널의 뮤엘 허브를 비활성화합니다.'),
    )
    .addSubcommand((sub) =>
      sub.setName(HUB_SUB_LIST).setDescription('이 서버의 활성화된 허브 채널 목록을 확인합니다.'),
    )
    .addSubcommand((sub) =>
      sub.setName(HUB_SUB_STATUS).setDescription('이 채널의 허브 상태를 확인합니다.'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON();

export const handleHubSlashInteraction = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  const supabase = getSupabaseClient();
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  if (!guildId) {
    await interaction.reply({
      content: '서버 안에서만 쓸 수 있어.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  // Defense in depth — Discord hides the command from users without
  // ManageChannels via setDefaultMemberPermissions, but the cache can lag.
  const hasPermission = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;
  if (!hasPermission) {
    await interaction.reply({
      content: '이 명령은 채널 관리 권한이 있는 사용자만 쓸 수 있어.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    void logMuelAgentAction(supabase, {
      triggerSource: 'slash_command',
      triggerDetail: `hub_${interaction.options.getSubcommand()}_denied`,
      status: 'denied',
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordUserId: interaction.user.id,
      metadata: { reason: 'missing_manage_channels' },
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === HUB_SUB_ACTIVATE) {
    try {
      await activateHubChannel(supabase, {
        guildId,
        channelId,
        activatedByUserId: interaction.user.id,
        activatedByUsername: interaction.user.username,
      });
      await interaction.reply({
        content: '이 채널에서 뮤엘이 살아 움직여요. 비활성화하려면 `/허브 비활성화`.',
        flags: [MessageFlags.Ephemeral],
      });
      void logMuelAgentAction(supabase, {
        triggerSource: 'slash_command',
        triggerDetail: 'hub_activate',
        status: 'responded',
        discordGuildId: guildId,
        discordChannelId: channelId,
        discordUserId: interaction.user.id,
        metadata: { username: interaction.user.username },
      });
    } catch (error) {
      console.error('[hub] activate failed', error);
      await interaction.reply({
        content: '허브 활성화에 실패했어. 잠시 뒤 다시 시도해줘.',
        flags: [MessageFlags.Ephemeral],
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
      await interaction.reply({
        content: '이 채널의 뮤엘 허브를 비활성화했어. 다시 켜려면 `/허브 활성화`.',
        flags: [MessageFlags.Ephemeral],
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
      await interaction.reply({
        content: '허브 비활성화에 실패했어. 잠시 뒤 다시 시도해줘.',
        flags: [MessageFlags.Ephemeral],
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
        await interaction.reply({
          content: '이 서버에 활성화된 허브 채널이 없어.',
          flags: [MessageFlags.Ephemeral],
        }).catch(() => {});
        return;
      }
      const lines = channels.map((row) => {
        const conf = row.responsiveConfidenceMin.toFixed(2);
        const who = row.activatedByUsername ? ` (by ${row.activatedByUsername})` : '';
        return `- <#${row.channelId}> · 응답 임계값 ${conf}${who}`;
      });
      await interaction.reply({
        content: [
          `활성 허브 채널 ${channels.length}개:`,
          ...lines,
        ].join('\n'),
        allowedMentions: { parse: [] },
        flags: [MessageFlags.Ephemeral],
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
      await interaction.reply({
        content: '허브 목록 조회에 실패했어.',
        flags: [MessageFlags.Ephemeral],
      }).catch(() => {});
    }
    return;
  }

  if (subcommand === HUB_SUB_STATUS) {
    const active = await isHubChannelActive(supabase, { guildId, channelId }).catch(() => false);
    await interaction.reply({
      content: active
        ? '이 채널은 뮤엘 허브로 활성화되어 있어. 일반 메시지에도 응답할 수 있어.'
        : '이 채널은 뮤엘 허브가 아니야. 활성화하려면 `/허브 활성화`.',
      flags: [MessageFlags.Ephemeral],
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

    if (
      !decision ||
      !RESPONSIVE_INTENTS.has(decision.intent) ||
      decision.confidence < responsiveMin
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
          reason: 'intent_not_responsive_or_low_confidence',
        },
      });
      return;
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
      userParts: [{ type: 'text', text: userText }],
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

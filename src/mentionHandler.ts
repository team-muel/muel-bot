import crypto from 'node:crypto';
import { PermissionFlagsBits, type Client, type Message } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { enqueueMemoryExtractionJob } from './muelJobs.js';
import { upsertDiscordMuelProfile } from './muelProfiles.js';
import {
  getUserHistorySummary,
  prepareChatTurn,
} from './muelConversationStore.js';
import { generateMuelReply, toDiscordReply } from './muelAgent.js';
import { formatForContext } from './channelBuffer.js';
import { formatGuildTopology } from './guildTopology.js';
import { config } from './config.js';
import { logMuelAiEvent } from './muelAiEvents.js';
import { shouldEnqueueUserMemoryExtraction } from './capabilities.js';
import { classifyMentionIntent } from './muelRouter.js';
import { acquireMentionSlot, formatLimitReplyMessage } from './mentionRateLimit.js';
import { logMuelAgentAction } from './agentActions.js';
import { REACTION_DONE, tagMessage } from './agentReactions.js';
import { classifyActionDraft } from './actionDraft.js';
import { buildHubActionConfirmation } from './actionConfirmations.js';

const recentRequests = new Map<string, { content: string; at: number }>();
const RECENT_REQUEST_TTL_MS = 20_000;
const RECENT_REQUEST_SWEEP_INTERVAL_MS = 60_000;

let lastRecentRequestSweepAt = 0;

const TOOLISH_TEXT_RE =
  /(최근|latest|news|뉴스|post|게시글|영상|video|shorts|쇼츠|기억|remember|전에|지난번|꿈|dream|schedule|일정)/iu;

const isLightweightTurn = (userText: string): boolean => {
  const normalized = userText.trim();
  return normalized.length > 0 && normalized.length <= 24 && !TOOLISH_TEXT_RE.test(normalized);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const stripBotMention = (content: string, botId: string): string => {
  return content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
};

const sweepRecentRequests = (now: number): void => {
  if (now - lastRecentRequestSweepAt < RECENT_REQUEST_SWEEP_INTERVAL_MS) return;
  lastRecentRequestSweepAt = now;

  for (const [key, value] of recentRequests.entries()) {
    if (now - value.at > RECENT_REQUEST_TTL_MS) {
      recentRequests.delete(key);
    }
  }
};

export const shouldMuelRespond = async (message: Message, client: Client<true>): Promise<boolean> => {
  if (message.author.bot) return false;
  if (!client.user) return false;

  const isDM = message.channel.isDMBased?.() ?? false;
  const explicitlyMentioned = message.mentions.users.has(client.user.id);

  let isReplyToMuel = false;
  if (message.reference?.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      isReplyToMuel = referencedMessage.author.id === client.user.id;
    } catch {
      // Ignored
    }
  }

  const startsWithCommand =
    message.content.startsWith('!muel') ||
    message.content.startsWith('/muel');

  return isDM || explicitlyMentioned || isReplyToMuel || startsWithCommand;
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

const pickUnknownField = (record: Record<string, unknown> | undefined, key: string): unknown => {
  if (!record) return undefined;
  return record[key];
};

export const handleMuelMention = async (
  client: Client<true>,
  message: Message,
): Promise<void> => {
  if (!(await shouldMuelRespond(message, client))) {
    return;
  }

  const userText = stripBotMention(message.content, client.user.id);
  if (!userText) {
    await message.reply({
      content: '부를 때 할 말도 같이 적어줘.',
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const requestKey = `${message.channelId}:${message.author.id}`;
  const now = Date.now();
  sweepRecentRequests(now);
  const previous = recentRequests.get(requestKey);
  if (previous && previous.content === userText && now - previous.at < RECENT_REQUEST_TTL_MS) {
    previous.at = now;
    await message.reply({
      content: '방금 본 내용이야. 너무 연속으로 보내면 곤란해.',
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }
  recentRequests.set(requestKey, { content: userText, at: now });

  const supabase = getSupabaseClient();

  // Rate limit / concurrency guard. Runs before any LLM work.
  const limitDecision = acquireMentionSlot({ userId: message.author.id, channelId: message.channelId });
  if (!limitDecision.allowed) {
    await message.reply({
      content: formatLimitReplyMessage(limitDecision),
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});

    const aiEventId = await logMuelAiEvent(supabase, {
      status: 'fallback',
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      lightweightTurn: isLightweightTurn(userText),
      taskType: 'chat',
      modelLane: 'chat',
      fallbackReason: limitDecision.reason,
      latencyMs: 0,
      metadata: {
        discordMessageId: message.id,
        retryHintSeconds: limitDecision.retryHintSeconds,
      },
    });

    void logMuelAgentAction(supabase, {
      triggerSource: 'mention',
      triggerDetail: 'rate_limit',
      status: 'rate_limited',
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      targetMessageId: message.id,
      aiEventId,
      metadata: { reason: limitDecision.reason, retryHintSeconds: limitDecision.retryHintSeconds },
    });
    return;
  }

  let inboundMessageId: string | null = null;
  let chatId: string | null = null;
  const lightweightTurn = isLightweightTurn(userText);
  const replyStartedAt = Date.now();

  try {
    const typingChannel = message.channel as { sendTyping?: () => Promise<void> };
    if (typeof typingChannel.sendTyping === 'function') {
      await typingChannel.sendTyping();
    }

    void upsertDiscordMuelProfile(supabase, message.author).catch((profileError) => {
      console.warn('[muel] profile upsert failed', profileError);
    });

    const userMessageId = crypto.randomUUID();
    const prepared = await prepareChatTurn(supabase, {
      source: 'discord',
      sourceChannelId: message.channelId,
      sourceThreadId: message.channelId,
      userMessageId,
      userParts: [{ type: 'text', text: userText }],
      metadata: {
        discordGuildId: message.guildId,
        discordChannelId: message.channelId,
        discordMessageId: message.id,
        discordUserId: message.author.id,
        discordUsername: message.author.username,
        externalMessageId: message.id,
      },
    });
    chatId = prepared.chatId;
    const history = prepared.messages;
    inboundMessageId = userMessageId;

    if (shouldEnqueueUserMemoryExtraction(userText)) {
      void enqueueMemoryExtractionJob(supabase, {
        chatId,
        messageId: userMessageId,
        source: 'discord',
        createdAt: new Date().toISOString(),
      });
    }

    // Router classification is awaited so the spam gate can short-circuit.
    // Even when the gate doesn't fire, the router row still lands in
    // muel_ai_events with task_type='router' inside classifyMentionIntent.
    const routerDecision = await classifyMentionIntent(supabase, {
      chatId,
      userText,
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
    });

    if (
      config.spamBlockEnabled &&
      routerDecision &&
      routerDecision.intent === 'spam' &&
      routerDecision.confidence >= config.spamBlockMinConfidence
    ) {
      // Silently drop. No Discord reply (per "응답 생략" decision). Audit row
      // captures the denial with router metadata for review.
      const aiEventId = await logMuelAiEvent(supabase, {
        status: 'fallback',
        chatId,
        messageId: inboundMessageId,
        discordGuildId: message.guildId,
        discordChannelId: message.channelId,
        discordUserId: message.author.id,
        latencyMs: Date.now() - replyStartedAt,
        lightweightTurn,
        taskType: 'chat',
        modelLane: 'chat',
        fallbackReason: 'spam_intent_blocked',
        metadata: {
          discordMessageId: message.id,
          routerIntent: routerDecision.intent,
          routerConfidence: routerDecision.confidence,
        },
      });
      void logMuelAgentAction(supabase, {
        triggerSource: 'mention',
        triggerDetail: 'spam_intent_blocked',
        status: 'denied',
        discordGuildId: message.guildId,
        discordChannelId: message.channelId,
        discordUserId: message.author.id,
        targetMessageId: message.id,
        aiEventId,
        metadata: {
          routerIntent: routerDecision.intent,
          routerConfidence: routerDecision.confidence,
        },
      });
      return;
    }

    if (message.guildId) {
      const draft = await classifyActionDraft(supabase, {
        chatId,
        userText,
        discordGuildId: message.guildId,
        discordChannelId: message.channelId,
        discordUserId: message.author.id,
      });

      if (draft && draft.action !== 'none' && draft.confidence >= 0.82) {
        const hasPermission = message.member?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false;
        if (!hasPermission) {
          const sent = await message.reply({
            content: '그 작업은 채널 관리 권한이 있어야 해. 권한이 있는 사람이 `/허브 활성화` 또는 `/허브 비활성화`로 처리할 수 있어.',
            allowedMentions: { parse: [], repliedUser: false },
          });
          void logMuelAgentAction(supabase, {
            triggerSource: 'mention',
            triggerDetail: `action_draft_${draft.action}`,
            status: 'denied',
            discordGuildId: message.guildId,
            discordChannelId: message.channelId,
            discordUserId: message.author.id,
            targetMessageId: message.id,
            responseMessageId: sent.id,
            metadata: { reason: 'missing_manage_channels', confidence: draft.confidence },
          });
          return;
        }

        const sent = await message.reply(buildHubActionConfirmation({
          action: draft.action,
          userId: message.author.id,
          channelId: message.channelId,
        }));
        void logMuelAgentAction(supabase, {
          triggerSource: 'mention',
          triggerDetail: `action_draft_${draft.action}`,
          status: 'responded',
          discordGuildId: message.guildId,
          discordChannelId: message.channelId,
          discordUserId: message.author.id,
          targetMessageId: message.id,
          responseMessageId: sent.id,
          metadata: { phase: 'pending_confirmation', confidence: draft.confidence, reason: draft.reason ?? null },
        });
        return;
      }
    }

    const mentionedUsers = message.mentions.users.filter((u) => u.id !== client.user.id && u.id !== message.author.id);
    const relevantUserIds = mentionedUsers.size > 0 ? mentionedUsers.map((u) => u.id) : [message.author.id];

    let userHistory = null;
    let mentionedHistories: Array<{ name: string; summary: Awaited<ReturnType<typeof getUserHistorySummary>> }> = [];
    let channelActivity = '';
    let guildTopology = '';

    if (!lightweightTurn) {
      const mentionedHistoryPromises = mentionedUsers.map((u) =>
        getUserHistorySummary(supabase, u.id).catch(() => null).then((summary) => ({
          name: u.displayName ?? u.username,
          summary,
        })),
      );

      [userHistory, ...mentionedHistories] = await Promise.all([
        getUserHistorySummary(supabase, message.author.id).catch(() => null),
        ...mentionedHistoryPromises,
      ]);

      channelActivity = formatForContext(message.channelId, client.user.id, 6);
      guildTopology = message.guild ? formatGuildTopology(message.guild) : '';
    }

    const authorName = message.author.displayName ?? message.author.username;
    const reply = await withTimeout(generateMuelReply(
      supabase,
      chatId,
      userText,
      authorName,
      history,
      message.guildId,
      relevantUserIds,
      channelActivity,
      userHistory,
      mentionedHistories,
      guildTopology,
      message.author.id,
      message.channelId,
    ), config.mentionReplyTimeoutMs, 'generateMuelReply');

    const sent = await message.reply({
      content: toDiscordReply(reply.text),
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });

    void tagMessage(message, REACTION_DONE);

    const meta = (reply.metadata ?? {}) as Record<string, unknown>;
    const taskType = pickStringField(meta, 'taskType') ?? 'chat';
    const modelLane = pickStringField(meta, 'modelLane') ?? 'chat';
    const fallbackReason = pickStringField(meta, 'fallbackReason');
    const modelCandidates = pickUnknownField(meta, 'modelCandidates');
    const inputTokens = pickNumberField(meta, 'inputTokens');
    const outputTokens = pickNumberField(meta, 'outputTokens');
    const totalTokens = pickNumberField(meta, 'totalTokens');

    console.log('[muel] mention replied', {
      event: 'mention_replied',
      chatId,
      messageId: inboundMessageId,
      model: reply.model,
      provider: reply.provider,
      latencyMs: Date.now() - replyStartedAt,
      lightweightTurn,
      taskType,
      modelLane,
      routerIntent: routerDecision?.intent ?? null,
      inputTokens,
      outputTokens,
      discordMessageId: message.id,
      discordReplyId: sent.id,
    });

    const aiEventId = await logMuelAiEvent(supabase, {
      status: reply.provider === 'none'
        ? 'fallback'
        : fallbackReason
          ? 'fallback'
          : 'success',
      chatId,
      messageId: inboundMessageId,
      responseMessageId: sent.id,
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      provider: reply.provider,
      model: reply.model,
      latencyMs: Date.now() - replyStartedAt,
      lightweightTurn,
      taskType,
      modelLane,
      fallbackReason,
      modelCandidates,
      inputTokens,
      outputTokens,
      totalTokens,
      metadata: {
        discordMessageId: message.id,
        routerIntent: routerDecision?.intent ?? null,
        routerConfidence: routerDecision?.confidence ?? null,
      },
    });

    void logMuelAgentAction(supabase, {
      triggerSource: 'mention',
      status: 'responded',
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      targetMessageId: message.id,
      responseMessageId: sent.id,
      aiEventId,
      metadata: {
        provider: reply.provider,
        model: reply.model,
        latencyMs: Date.now() - replyStartedAt,
        taskType,
        modelLane,
        routerIntent: routerDecision?.intent ?? null,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[muel] mention handling failed', error);
    console.warn('[muel] mention failed metadata', {
      event: 'mention_failed',
      messageId: inboundMessageId,
      reason,
      stack: error instanceof Error ? error.stack : undefined,
    });

    await message.reply({
      content: '지금은 대답하기 어려워. 잠시 뒤에 다시 불러줘.',
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});

    const aiEventId = await logMuelAiEvent(supabase, {
      status: 'error',
      chatId,
      messageId: inboundMessageId,
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      latencyMs: Date.now() - replyStartedAt,
      lightweightTurn,
      taskType: 'chat',
      modelLane: 'chat',
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: reason,
      metadata: {
        discordMessageId: message.id,
      },
    });

    void logMuelAgentAction(supabase, {
      triggerSource: 'mention',
      status: 'error',
      discordGuildId: message.guildId,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      targetMessageId: message.id,
      aiEventId,
      metadata: { errorMessage: reason.slice(0, 240) },
    });
  } finally {
    limitDecision.release();
  }
};

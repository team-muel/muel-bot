import crypto from 'node:crypto';
import type { Client, Message } from 'discord.js';
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

const shouldMuelRespond = async (message: Message, client: Client<true>): Promise<boolean> => {
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
  let inboundMessageId: string | null = null;
  const lightweightTurn = isLightweightTurn(userText);

  try {
    const typingChannel = message.channel as { sendTyping?: () => Promise<void> };
    if (typeof typingChannel.sendTyping === 'function') {
      await typingChannel.sendTyping();
    }

    void upsertDiscordMuelProfile(supabase, message.author).catch((profileError) => {
      console.warn('[muel] profile upsert failed', profileError);
    });

    const userMessageId = crypto.randomUUID();
    const { chatId, messages: history } = await prepareChatTurn(supabase, {
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
    inboundMessageId = userMessageId;

    void enqueueMemoryExtractionJob(supabase, {
      chatId,
      messageId: userMessageId,
      source: 'discord',
      createdAt: new Date().toISOString(),
    });

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
    const replyStartedAt = Date.now();
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
    ), config.mentionReplyTimeoutMs, 'generateMuelReply');

    const sent = await message.reply({
      content: toDiscordReply(reply.text),
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });

    console.log('[muel] mention replied', {
      event: 'mention_replied',
      chatId,
      messageId: inboundMessageId,
      model: reply.model,
      provider: reply.provider,
      latencyMs: Date.now() - replyStartedAt,
      lightweightTurn,
      discordMessageId: message.id,
      discordReplyId: sent.id,
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
  }
};

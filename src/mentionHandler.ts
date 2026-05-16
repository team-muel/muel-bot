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

const recentRequests = new Map<string, { content: string; at: number }>();

const stripBotMention = (content: string, botId: string): string => {
  return content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
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
  const previous = recentRequests.get(requestKey);
  const now = Date.now();
  if (previous && previous.content === userText && now - previous.at < 20_000) {
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

  try {
    const typingChannel = message.channel as { sendTyping?: () => Promise<void> };
    if (typeof typingChannel.sendTyping === 'function') {
      await typingChannel.sendTyping();
    }

    const profileId = await upsertDiscordMuelProfile(supabase, message.author);
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

    // Enqueue job safely without awaiting the outcome or blocking the hot-path
    void enqueueMemoryExtractionJob(supabase, {
      chatId,
      messageId: userMessageId,
      source: 'discord',
      createdAt: new Date().toISOString(),
    });

    const mentionedUsers = message.mentions.users.filter((u) => u.id !== client.user.id && u.id !== message.author.id);
    const relevantUserIds = mentionedUsers.size > 0
      ? mentionedUsers.map((u) => u.id)
      : [message.author.id];
    const mentionedHistoryPromises = mentionedUsers.map((u) =>
      getUserHistorySummary(supabase, u.id).catch(() => null).then((summary) => ({
        name: u.displayName ?? u.username,
        summary,
      })),
    );

    const [userHistory, ...mentionedHistories] = await Promise.all([
      getUserHistorySummary(supabase, message.author.id).catch(() => null),
      ...mentionedHistoryPromises,
    ]);

    const channelActivity = formatForContext(message.channelId, client.user.id);
    const guildTopology = message.guild ? formatGuildTopology(message.guild) : '';
    const authorName = message.author.displayName ?? message.author.username;
    
    const reply = await generateMuelReply(
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
    );
    const sent = await message.reply({
      content: toDiscordReply(reply.text),
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });

    // Embeddings generation is now skipped from this synchronous path, as it will be handled async via a queue/webhook later.
    // storeMessageEmbedding(supabase, inboundMessageId, userText).catch((error) => {
    //   console.warn('[muel] message embedding skipped', error);
    // });

    // The assistant message is now saved by the AI SDK stream onFinish hook. 
    // We pass the chatId to generateMuelReply to do this.


    console.log('[muel] mention replied', {
      event: 'mention_replied',
      chatId,
      messageId: inboundMessageId,
      model: reply.model,
      provider: reply.provider,
      discordMessageId: message.id,
      discordReplyId: sent.id,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[muel] mention handling failed', error);
    console.warn('[muel] mention failed', {
      event: 'mention_failed',
      messageId: inboundMessageId,
      reason,
    });

    await message.reply({
      content: '지금은 대답하기 어려워. 잠시 뒤에 다시 불러줘.',
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }
};

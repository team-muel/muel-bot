import type { Client, Message } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { upsertDiscordMuelProfile } from './muelProfiles.js';
import {
  getUserHistorySummary,
  insertMuelEvent,
  insertMuelMessage,
  listRecentMuelMessages,
  upsertDiscordConversation,
} from './muelConversationStore.js';
import { generateMuelReply, toDiscordReply } from './muelAgent.js';
import { formatForContext } from './channelBuffer.js';
import { formatGuildTopology } from './guildTopology.js';
import { storeMessageEmbedding } from './muelEmbeddings.js';

const recentRequests = new Map<string, { content: string; at: number }>();

const stripBotMention = (content: string, botId: string): string => {
  return content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
};

export const handleMuelMention = async (
  client: Client<true>,
  message: Message,
): Promise<void> => {
  if (message.author.bot || !client.user || !message.mentions.users.has(client.user.id)) {
    return;
  }

  const userText = stripBotMention(message.content, client.user.id);
  if (!userText) {
    await message.reply('부를 거면 한 문장만 같이 적어줘.');
    return;
  }

  const requestKey = `${message.channelId}:${message.author.id}`;
  const previous = recentRequests.get(requestKey);
  const now = Date.now();
  if (previous && previous.content === userText && now - previous.at < 20_000) {
    previous.at = now;
    await message.reply('그거 방금 봤어. 같은 말 여러 번 보내면 내가 좀 느려져.');
    return;
  }
  recentRequests.set(requestKey, { content: userText, at: now });

  const supabase = getSupabaseClient();
  let conversationId: string | null = null;
  let inboundMessageId: string | null = null;

  try {
    const typingChannel = message.channel as { sendTyping?: () => Promise<void> };
    if (typeof typingChannel.sendTyping === 'function') {
      await typingChannel.sendTyping();
    }

    const profileId = await upsertDiscordMuelProfile(supabase, message.author);
    const conversation = await upsertDiscordConversation(supabase, message, profileId);
    conversationId = conversation.id;

    const inbound = await insertMuelMessage(supabase, {
      conversationId,
      direction: 'inbound',
      role: 'user',
      externalMessageId: message.id,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      content: userText,
      metadata: {
        guild_id: message.guildId,
        channel_id: message.channelId,
      },
    });
    inboundMessageId = inbound.id;

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

    const [history, userHistory, ...mentionedHistories] = await Promise.all([
      listRecentMuelMessages(supabase, conversationId, 12),
      getUserHistorySummary(supabase, message.author.id, conversationId).catch(() => null),
      ...mentionedHistoryPromises,
    ]);

    const channelActivity = formatForContext(message.channelId, client.user.id);
    const guildTopology = message.guild ? formatGuildTopology(message.guild) : '';
    const authorName = message.author.displayName ?? message.author.username;
    
    const reply = await generateMuelReply(
      supabase,
      userText,
      authorName,
      history,
      message.guildId,
      relevantUserIds,
      channelActivity,
      userHistory,
      mentionedHistories,
      guildTopology
    );
    const sent = await message.reply(toDiscordReply(reply.text));

    storeMessageEmbedding(supabase, inbound.id, userText).catch((error) => {
      console.warn('[muel] message embedding skipped', error);
    });

    await insertMuelMessage(supabase, {
      conversationId,
      direction: 'outbound',
      role: 'assistant',
      externalMessageId: sent.id,
      content: reply.text,
      model: reply.model,
      metadata: {
        reply_to: message.id,
        provider: reply.provider,
      },
    });

    await insertMuelEvent(supabase, {
      conversationId,
      messageId: inboundMessageId,
      eventType: 'mention_replied',
      metadata: {
        model: reply.model,
        provider: reply.provider,
        discord_message_id: message.id,
        discord_reply_id: sent.id,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[muel] mention handling failed', error);

    if (conversationId) {
      await insertMuelEvent(supabase, {
        conversationId,
        messageId: inboundMessageId,
        eventType: 'mention_failed',
        status: 'error',
        metadata: { reason },
      }).catch(() => {});
    }

    await message.reply('지금은 응답을 만들지 못했어. 잠시 뒤 다시 불러줘.').catch(() => {});
  }
};

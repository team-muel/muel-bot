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
import { fetchServerContext } from './muelContext.js';
import { formatForContext } from './channelBuffer.js';

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
  if (message.author.bot || !client.user || !message.mentions.has(client.user)) {
    return;
  }

  const userText = stripBotMention(message.content, client.user.id);
  if (!userText) {
    await message.reply('불렀다면 한 문장만 같이 적어주세요.');
    return;
  }

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

    const [history, serverContext, userHistory] = await Promise.all([
      listRecentMuelMessages(supabase, conversationId, 12),
      fetchServerContext().catch(() => undefined),
      getUserHistorySummary(supabase, message.author.id, conversationId).catch(() => null),
    ]);
    const channelActivity = formatForContext(message.channelId, client.user.id);
    const authorName = message.author.displayName ?? message.author.username;
    const reply = await generateMuelReply(userText, authorName, history, serverContext, channelActivity, userHistory);
    const sent = await message.reply(toDiscordReply(reply.text));

    await insertMuelMessage(supabase, {
      conversationId,
      direction: 'outbound',
      role: 'assistant',
      externalMessageId: sent.id,
      content: reply.text,
      model: reply.model,
      metadata: {
        reply_to: message.id,
      },
    });

    await insertMuelEvent(supabase, {
      conversationId,
      messageId: inboundMessageId,
      eventType: 'mention_replied',
      metadata: {
        model: reply.model,
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

    await message.reply('지금은 응답을 만들지 못했어요. 잠시 뒤 다시 불러주세요.').catch(() => {});
  }
};

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Message } from 'discord.js';

export type MuelConversation = {
  id: string;
};

export type MuelStoredMessage = {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
};

export const getDiscordConversationKey = (message: Message): string => {
  const guildId = message.guildId ?? 'dm';
  return `${guildId}:${message.channelId}`;
};

export const upsertDiscordConversation = async (
  supabase: SupabaseClient,
  message: Message,
  profileId: string | null,
): Promise<MuelConversation> => {
  const externalThreadId = getDiscordConversationKey(message);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('muel_conversations')
    .upsert(
      {
        platform: 'discord',
        external_thread_id: externalThreadId,
        discord_guild_id: message.guildId,
        discord_channel_id: message.channelId,
        discord_user_id: message.author.id,
        muel_profile_id: profileId,
        metadata: {
          channel_type: message.channel.type,
          last_discord_message_id: message.id,
        },
        last_message_at: now,
        updated_at: now,
      },
      { onConflict: 'platform,external_thread_id' },
    )
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data as MuelConversation;
};

export const insertMuelMessage = async (
  supabase: SupabaseClient,
  input: {
    conversationId: string;
    direction: 'inbound' | 'outbound' | 'internal';
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    externalMessageId?: string | null;
    discordUserId?: string | null;
    discordUsername?: string | null;
    model?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<MuelStoredMessage> => {
  const { data, error } = await supabase
    .from('muel_messages')
    .insert({
      conversation_id: input.conversationId,
      platform: 'discord',
      direction: input.direction,
      role: input.role,
      external_message_id: input.externalMessageId,
      discord_user_id: input.discordUserId,
      discord_username: input.discordUsername,
      content: input.content,
      model: input.model,
      metadata: input.metadata ?? {},
    })
    .select('id, content, role')
    .single();

  if (error) {
    throw error;
  }

  return data as MuelStoredMessage;
};

export const listRecentMuelMessages = async (
  supabase: SupabaseClient,
  conversationId: string,
  limit = 10,
): Promise<MuelStoredMessage[]> => {
  const { data, error } = await supabase
    .from('muel_messages')
    .select('id, content, role')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return ((data ?? []) as MuelStoredMessage[]).reverse();
};

export type UserHistorySummary = {
  totalInteractions: number;
  recentTopics: string[];
  lastActiveAt: string | null;
};

export const getUserHistorySummary = async (
  supabase: SupabaseClient,
  discordUserId: string,
  excludeConversationId?: string,
): Promise<UserHistorySummary | null> => {
  let query = supabase
    .from('muel_messages')
    .select('content, role, created_at')
    .eq('discord_user_id', discordUserId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(20);

  if (excludeConversationId) {
    query = query.neq('conversation_id', excludeConversationId);
  }

  const { data, error } = await query;

  if (error || !data || data.length === 0) {
    return null;
  }

  const messages = data as Array<{ content: string; role: string; created_at: string }>;
  const recentContents = messages
    .slice(0, 8)
    .map((m) => m.content.slice(0, 80));

  return {
    totalInteractions: messages.length,
    recentTopics: recentContents,
    lastActiveAt: messages[0]?.created_at ?? null,
  };
};

export const insertMuelEvent = async (
  supabase: SupabaseClient,
  input: {
    conversationId?: string | null;
    messageId?: string | null;
    eventType: string;
    status?: 'ok' | 'error' | 'skipped';
    metadata?: Record<string, unknown>;
  },
): Promise<void> => {
  const { error } = await supabase.from('muel_events').insert({
    conversation_id: input.conversationId,
    message_id: input.messageId,
    event_type: input.eventType,
    platform: 'discord',
    status: input.status ?? 'ok',
    metadata: input.metadata ?? {},
  });

  if (error) {
    throw error;
  }
};

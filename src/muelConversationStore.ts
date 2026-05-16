import type { SupabaseClient } from '@supabase/supabase-js';
import type { UIMessage as AiUIMessage } from 'ai';

export type MuelConversation = {
  id: string;
};

export type MuelStoredMessage = {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
};

export type UIMessage = Omit<AiUIMessage, 'createdAt' | 'metadata'> & {
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export type ChatTurnResponse = {
  chatId: string;
  messages: UIMessage[];
};

export const prepareChatTurn = async (
  supabase: SupabaseClient,
  input: {
    source: string;
    sourceChannelId: string;
    sourceThreadId: string;
    userMessageId: string;
    userParts: any[];
    metadata: Record<string, unknown>;
  }
): Promise<ChatTurnResponse> => {
  const { data, error } = await supabase.rpc('prepare_chat_turn', {
    p_source: input.source,
    p_source_channel_id: input.sourceChannelId,
    p_source_thread_id: input.sourceThreadId,
    p_user_message_id: input.userMessageId,
    p_user_parts: input.userParts,
    p_metadata: input.metadata,
  });

  if (error) throw error;
  return data as ChatTurnResponse;
};

export const saveAssistantMessage = async (
  supabase: SupabaseClient,
  chatId: string,
  messageId: string,
  parts: any[],
  metadata: Record<string, unknown> = {}
): Promise<void> => {
  const { error } = await supabase.from('muel_messages_v2').insert({
    id: messageId,
    chat_id: chatId,
    role: 'assistant',
    parts,
    source: 'system',
    metadata,
  });
  if (error) console.error('[muel] failed to save assistant message', error);
};


export type UserHistorySummary = {
  totalInteractions: number;
  recentTopics: string[];
  lastActiveAt: string | null;
};

export const getUserHistorySummary = async (
  supabase: SupabaseClient,
  discordUserId: string,
): Promise<UserHistorySummary | null> => {
  // Find chats belonging to this user
  const { data: chats, error: chatError } = await supabase
    .from('muel_chats')
    .select('id')
    .eq('source_user_id', discordUserId);

  if (chatError || !chats || chats.length === 0) {
    return null;
  }

  const chatIds = chats.map((c: any) => c.id);

  const { data, error } = await supabase
    .from('muel_messages_v2')
    .select('parts, role, created_at')
    .in('chat_id', chatIds)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data || data.length === 0) {
    return null;
  }

  const recentContents = data
    .slice(0, 8)
    .map((m: any) => {
      if (!m.parts || !Array.isArray(m.parts)) return '';
      const textPart = m.parts.find((p: any) => p.type === 'text');
      return textPart ? textPart.text.slice(0, 80) : '';
    })
    .filter(Boolean);

  return {
    totalInteractions: data.length,
    recentTopics: recentContents,
    lastActiveAt: data[0]?.created_at ?? null,
  };
};

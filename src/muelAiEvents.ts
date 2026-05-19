import type { SupabaseClient } from '@supabase/supabase-js';

export type MuelAiEventStatus = 'success' | 'fallback' | 'error';

export type MuelAiEventInput = {
  source?: string;
  status: MuelAiEventStatus;
  chatId?: string | null;
  messageId?: string | null;
  responseMessageId?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  lightweightTurn?: boolean;
  errorClass?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
};

export const logMuelAiEvent = async (
  supabase: SupabaseClient,
  input: MuelAiEventInput,
): Promise<void> => {
  const { error } = await supabase.from('muel_ai_events').insert({
    source: input.source ?? 'discord',
    status: input.status,
    chat_id: input.chatId ?? null,
    message_id: input.messageId ?? null,
    response_message_id: input.responseMessageId ?? null,
    discord_guild_id: input.discordGuildId ?? null,
    discord_channel_id: input.discordChannelId ?? null,
    discord_user_id: input.discordUserId ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    latency_ms: input.latencyMs ?? null,
    lightweight_turn: input.lightweightTurn ?? false,
    error_class: input.errorClass ?? null,
    error_message: input.errorMessage?.slice(0, 2000) ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn('[muel-ai-events] insert failed', error);
  }
};

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
  taskType?: string | null;
  modelLane?: string | null;
  fallbackReason?: string | null;
  modelCandidates?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  metadata?: Record<string, unknown>;
};

const toIntOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
};

/**
 * Returns the inserted row id, or null on failure. Callers that need to link
 * an agent action (mention/concierge handlers) should capture this id and
 * pass it to logMuelAgentAction(.ai_event_id).
 */
export const logMuelAiEvent = async (
  supabase: SupabaseClient,
  input: MuelAiEventInput,
): Promise<string | null> => {
  const { data, error } = await supabase
    .from('muel_ai_events')
    .insert({
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
      task_type: input.taskType ?? null,
      model_lane: input.modelLane ?? null,
      fallback_reason: input.fallbackReason ?? null,
      model_candidates: input.modelCandidates ?? null,
      input_tokens: toIntOrNull(input.inputTokens),
      output_tokens: toIntOrNull(input.outputTokens),
      total_tokens: toIntOrNull(input.totalTokens),
      metadata: input.metadata ?? {},
    })
    .select('id')
    .single();

  if (error) {
    console.warn('[muel-ai-events] insert failed', error);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
};

export type GenerateUsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
};

export const extractUsageTokens = (usage: GenerateUsageLike | null | undefined): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} => {
  if (!usage) {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? null;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? null;
  const totalTokens = usage.totalTokens ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  return { inputTokens, outputTokens, totalTokens };
};

export type ResolvedModelSummary = {
  provider: string;
  modelId: string;
  task: string;
};

/**
 * Returns the inserted row id (or null on failure) so callers that audit via
 * muel_agent_actions can link the rows.
 */
export const logMuelBackgroundAiEvent = (
  supabase: SupabaseClient,
  args: {
    source: string;
    status: MuelAiEventStatus;
    taskType: string;
    resolvedModel: ResolvedModelSummary;
    startedAt: number;
    usage?: GenerateUsageLike | null;
    errorClass?: string | null;
    errorMessage?: string | null;
    chatId?: string | null;
    fallbackReason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<string | null> => {
  const tokens = extractUsageTokens(args.usage);
  return logMuelAiEvent(supabase, {
    source: args.source,
    status: args.status,
    chatId: args.chatId ?? null,
    provider: args.resolvedModel.provider,
    model: args.resolvedModel.modelId,
    latencyMs: Date.now() - args.startedAt,
    fallbackReason: args.fallbackReason ?? null,
    taskType: args.taskType,
    modelLane: args.resolvedModel.task,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    errorClass: args.errorClass ?? null,
    errorMessage: args.errorMessage ?? null,
    metadata: args.metadata ?? {},
  });
};

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
 * 공통 AI 에러 분류. 스키마 매칭 실패류(AI_NoObjectGeneratedError / "did not match
 * schema")는 *분류·품질 실패*일 뿐 시스템 에러가 아니므로 status='fallback' 으로 분류해
 * triage/sentinel 임계 노이즈에서 뺀다. 진짜 인프라·결제 에러(AI_RetryError 등)만 'error'.
 * router·summary·extract·action_draft 등 generateObject 레인이 공유해 분기 일관성 유지.
 */
export const classifyAiError = (
  err: unknown,
): { errorClass: string; errorMessage: string; isSchemaFailure: boolean; status: MuelAiEventStatus } => {
  const errorClass = err instanceof Error ? err.name : ((err as any)?.constructor?.name || typeof err);
  const errorMessage = err instanceof Error ? err.message : (() => {
    const message = (err as any)?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
    try {
      const serialized = JSON.stringify(err);
      if (serialized && serialized !== "{}" && serialized !== "[object Object]") {
        return serialized;
      }
    } catch {
      // Fall through to String(err).
    }
    return String(err);
  })();
  const isSchemaFailure =
    errorClass === 'AI_NoObjectGeneratedError' || errorMessage.includes('did not match schema');
  return { errorClass, errorMessage, isSchemaFailure, status: isSchemaFailure ? 'fallback' : 'error' };
};

/**
 * withFallback 미들웨어(modelRegistry)가 게이트웨이 복구 시 result.providerMetadata.muel 에
 * 심는 마커 판독. 1차(Gemini) 실패를 게이트웨이(MindLogic)가 구해낸 호출을 호출자가 식별.
 */
export const readFallbackMeta = (
  providerMetadata: unknown,
): { used: boolean; from?: string; to?: string } => {
  const muel = (
    providerMetadata as
      | { muel?: { fallback_used?: boolean; fallback_from?: string; fallback_to?: string } }
      | null
      | undefined
  )?.muel;
  if (muel?.fallback_used) {
    return { used: true, from: muel.fallback_from, to: muel.fallback_to };
  }
  return { used: false };
};

/**
 * Returns the inserted row id (or null on failure) so callers that audit via
 * muel_agent_actions can link the rows.
 *
 * `providerMetadata`(generateObject/generateText 결과)를 넘기면, 게이트웨이가 1차 실패를
 * 구해낸 호출(호출자 시점엔 success)을 status='fallback' + 실제 서빙 provider 로 보정한다.
 * 없으면 게이트웨이 복구가 전부 success/provider=gemini 로 잡혀 폴백 발동·MindLogic 소진이
 * 텔레메트리에서 안 보인다(= ADR-004 첫 run 제안 #1).
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
    providerMetadata?: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<string | null> => {
  const tokens = extractUsageTokens(args.usage);
  const fb = readFallbackMeta(args.providerMetadata);
  const recovered = fb.used && args.status === 'success';
  return logMuelAiEvent(supabase, {
    source: args.source,
    status: recovered ? 'fallback' : args.status,
    chatId: args.chatId ?? null,
    provider: recovered ? (fb.to?.split(':')[0] ?? args.resolvedModel.provider) : args.resolvedModel.provider,
    model: recovered ? (fb.to ?? args.resolvedModel.modelId) : args.resolvedModel.modelId,
    latencyMs: Date.now() - args.startedAt,
    fallbackReason: recovered ? 'gateway_recovery' : (args.fallbackReason ?? null),
    taskType: args.taskType,
    modelLane: args.resolvedModel.task,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    errorClass: args.errorClass ?? null,
    errorMessage: args.errorMessage ?? null,
    metadata: recovered
      ? { ...(args.metadata ?? {}), fallback_from: fb.from ?? null, fallback_to: fb.to ?? null }
      : (args.metadata ?? {}),
  });
};

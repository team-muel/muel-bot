/**
 * ADR-003 P2a + P10 — AI SDK middleware (wrapLanguageModel) 로
 * 모든 LLM 호출에 *공통 telemetry hook* 을 얹는다.
 *
 * 첫 단계 책임 (이 PR):
 * - latency (ms) 측정 + console 로그.
 * - input/output token usage 로그 + provider/modelId 표시.
 * - 에러 시 짧은 에러 메시지 + provider 컨텍스트.
 *
 * 후속 (별도 PR):
 * - P2b rate-limit (per-user, per-provider).
 * - P2c caching (fingerprint or semantic).
 * - P10 의 muel_ai_events 자동 insert (현재는 console + 다른 경로 적재).
 *
 * 적용처: `modelRegistry.ts` 의 `getGeminiTextModel` / `getFallbackTextModel`
 * 가 반환하는 model 을 `wrapLanguageModel` 로 감싼다.
 */

import { wrapLanguageModel } from 'ai';

// AI SDK v6 의 LanguageModel union 이 LanguageModelV2/V3 + string 까지 포함.
// wrapLanguageModel 는 V3 인스턴스만 받기 때문에 wrapper signature 는 `any` 로 받고
// 호출자가 적절히 cast. 우리는 modelRegistry 의 provider 가 반환한 object 만 wrap.
type WrappableLM = any;

const fmtMs = (ms: number): string => `${ms.toFixed(0)}ms`;

const usageSummary = (usage: any): string => {
  if (!usage || typeof usage !== 'object') return '?';
  const input = usage.inputTokens ?? usage.promptTokens ?? null;
  const output = usage.outputTokens ?? usage.completionTokens ?? null;
  const total = usage.totalTokens ?? null;
  return `in=${input ?? '?'} out=${output ?? '?'} total=${total ?? '?'}`;
};

export type TelemetryContext = {
  provider: string;
  modelId: string;
  task?: string;
};

/**
 * 단일 LLM 모델을 telemetry middleware 로 wrap.
 *
 * doGenerate / doStream 시점에:
 * - startedAt 기록
 * - 호출 직후 latency + usage 로그
 * - 에러 시 짧은 에러 로그 (throw 는 그대로 propagate)
 */
export const withTelemetry = (model: WrappableLM, ctx: TelemetryContext): WrappableLM => {
  return wrapLanguageModel({
    model,
    middleware: {
      // @ts-ignore AI SDK v6 middleware typing 이 일부 wrapper 와 미세 차이 — 정성적 cast.
      wrapGenerate: async ({ doGenerate, params }: { doGenerate: () => Promise<any>; params: any }) => {
        const startedAt = Date.now();
        try {
          const result = await doGenerate();
          const elapsed = Date.now() - startedAt;
          console.log('[ai-telemetry]', {
            phase: 'generate',
            provider: ctx.provider,
            model: ctx.modelId,
            task: ctx.task ?? '?',
            latency: fmtMs(elapsed),
            usage: usageSummary(result?.usage),
            stop: result?.finishReason ?? '?',
          });
          return result;
        } catch (err) {
          const elapsed = Date.now() - startedAt;
          console.warn('[ai-telemetry] generate error', {
            provider: ctx.provider,
            model: ctx.modelId,
            task: ctx.task ?? '?',
            latency: fmtMs(elapsed),
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
      // @ts-ignore
      wrapStream: async ({ doStream, params }: { doStream: () => Promise<any>; params: any }) => {
        const startedAt = Date.now();
        try {
          const result = await doStream();
          console.log('[ai-telemetry]', {
            phase: 'stream-start',
            provider: ctx.provider,
            model: ctx.modelId,
            task: ctx.task ?? '?',
            latency: fmtMs(Date.now() - startedAt),
          });
          return result;
        } catch (err) {
          console.warn('[ai-telemetry] stream error', {
            provider: ctx.provider,
            model: ctx.modelId,
            task: ctx.task ?? '?',
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    },
  });
};

/**
 * Primary 모델 호출이 실패하면(예: Gemini 크레딧 고갈) fallback 모델로 *투명하게* 재시도.
 * params 를 그대로 fallback 에 넘긴다(LanguageModel doGenerate/doStream 스펙 공통).
 * 적용처: getGeminiTextModel — 전 레인(router/extract/summary/chat 등)이 자동 폴백.
 */
export const withFallback = (
  primary: WrappableLM,
  fallback: WrappableLM | null,
  ctx: { fromModelId: string; toModelId: string; task?: string },
): WrappableLM => {
  if (!fallback) return primary;
  return wrapLanguageModel({
    model: primary,
    middleware: {
      // @ts-ignore AI SDK v6 middleware typing 미세 차이 — 정성적 cast.
      wrapGenerate: async ({ doGenerate, params }: { doGenerate: () => Promise<any>; params: any }) => {
        try {
          return await doGenerate();
        } catch (err) {
          console.warn('[ai-fallback] generate primary->fallback', {
            from: ctx.fromModelId,
            to: ctx.toModelId,
            task: ctx.task ?? '?',
            error: err instanceof Error ? err.message : String(err),
          });
          return await (fallback as any).doGenerate(params);
        }
      },
      // @ts-ignore
      wrapStream: async ({ doStream, params }: { doStream: () => Promise<any>; params: any }) => {
        try {
          return await doStream();
        } catch (err) {
          console.warn('[ai-fallback] stream primary->fallback', {
            from: ctx.fromModelId,
            to: ctx.toModelId,
            error: err instanceof Error ? err.message : String(err),
          });
          return await (fallback as any).doStream(params);
        }
      },
    },
  });
};

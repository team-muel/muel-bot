/**
 * 프로바이더 도달성 healthcheck — 부팅 시 각 설정된 프로바이더/모델에 초소형
 * generate 를 날려 muel_ai_events(source='healthcheck') 로 적재한다.
 *
 * Why: NVIDIA NIM 경로는 배선만 있고 실제 도달이 한 번도 검증된 적 없었고
 * ("key currently inactive" 시절 주석), MindLogic 게이트웨이 모델 ID 교체
 * (예: MINDLOGIC_CHAT_MODEL) 도 첫 실트래픽 전엔 유효성을 알 수 없었다.
 * 라우팅을 적극적으로 바꾸려면(heavy→NVIDIA 등) "이 경로로 답이 실제로
 * 돌아온다" 가 텔레메트리에 찍혀야 한다 — 추측 말고 관측.
 *
 * 설계:
 * - 폴백 없는 bare 모델(getBareTextModel)로 프로브 — 폴백이 끼면 성공이
 *   어느 프로바이더 덕인지 귀속(attribution)이 깨진다.
 * - 순차 실행(버스트 방지), 프로브당 maxOutputTokens 64 · maxRetries 0.
 * - 실패해도 봇 기동에 영향 없음(fire-and-forget, 절대 throw 안 함).
 * - 비용: 부팅당 프로브 3~5회 × 수십 토큰 — 무시 가능.
 *
 * 판독: muel_ai_events 에서 source='healthcheck' 필터.
 *   status='success' = 해당 provider/model 로 실제 응답 도달.
 *   status='error'   = error_class/error_message 로 원인(무효 키·무효 모델ID 등) 확인.
 */

import { generateText } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { getBareTextModel, type MuelModelProvider } from './modelRegistry.js';
import { classifyAiError, logMuelBackgroundAiEvent } from './muelAiEvents.js';

type Probe = { provider: MuelModelProvider; modelId: string; note: string };

/** 실제 라우팅에 쓰(일 수 있)는 프로바이더×모델 조합만 프로브한다. */
const buildProbes = (): Probe[] => {
  const probes: Probe[] = [];
  if (config.googleGenerativeAiApiKey) {
    probes.push({ provider: 'gemini', modelId: config.muelChatModel, note: 'lane-default' });
  }
  if (config.mindlogicApiKey) {
    probes.push({ provider: 'mindlogic', modelId: config.mindlogicChatModel, note: 'chat-lane' });
    if (config.mindlogicModel !== config.mindlogicChatModel) {
      probes.push({ provider: 'mindlogic', modelId: config.mindlogicModel, note: 'gateway-fallback' });
    }
  }
  if (config.nvidiaApiKey) {
    probes.push({ provider: 'nvidia', modelId: config.nvidiaHeavyModel, note: 'heavy-lane' });
    if (config.nvidiaModel !== config.nvidiaHeavyModel) {
      probes.push({ provider: 'nvidia', modelId: config.nvidiaModel, note: 'nvidia-fallback' });
    }
  }
  // 후보 모델 실측 (PROBE_EXTRA_MODELS="provider:modelId,..."). 레인 교체 *전에*
  // 도달성·레이턴시를 텔레메트리로 재는 용도 — env 만으로 붙였다 뗄 수 있다.
  for (const raw of (config.probeExtraModels ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const sep = entry.indexOf(':');
    if (sep <= 0 || sep === entry.length - 1) {
      console.warn('[provider-healthcheck] malformed PROBE_EXTRA_MODELS entry, skipping:', entry);
      continue;
    }
    const provider = entry.slice(0, sep) as MuelModelProvider;
    const modelId = entry.slice(sep + 1);
    if (provider !== 'gemini' && provider !== 'mindlogic' && provider !== 'nvidia') {
      console.warn('[provider-healthcheck] unknown provider in PROBE_EXTRA_MODELS, skipping:', entry);
      continue;
    }
    probes.push({ provider, modelId, note: 'extra-probe' });
  }
  return probes;
};

const PROBE_PROMPT = 'healthcheck ping. Reply with the single word: pong';

export const runProviderHealthcheck = async (supabase: SupabaseClient | null): Promise<void> => {
  if (!config.enableProviderHealthcheck) return;
  const probes = buildProbes();
  if (probes.length === 0) return;
  console.log('[provider-healthcheck] probing', probes.map((p) => `${p.provider}:${p.modelId}`).join(', '));

  for (const probe of probes) {
    const startedAt = Date.now();
    const bare = getBareTextModel(probe.provider, probe.modelId);
    if (!bare) continue;
    try {
      const { usage, finishReason } = await generateText({
        model: bare.model,
        prompt: PROBE_PROMPT,
        maxOutputTokens: 64,
        maxRetries: 0,
        temperature: 0,
      });
      console.log('[provider-healthcheck] ok', { provider: probe.provider, model: bare.modelId, finishReason });
      if (supabase) {
        await logMuelBackgroundAiEvent(supabase, {
          source: 'healthcheck',
          status: 'success',
          taskType: 'provider_healthcheck',
          resolvedModel: { provider: probe.provider, modelId: bare.modelId, task: 'healthcheck' },
          startedAt,
          usage,
          metadata: { note: probe.note, finishReason: finishReason ?? null },
        });
      }
    } catch (err) {
      const { errorClass, errorMessage } = classifyAiError(err);
      console.warn('[provider-healthcheck] FAILED', { provider: probe.provider, model: bare.modelId, errorClass, errorMessage });
      if (supabase) {
        await logMuelBackgroundAiEvent(supabase, {
          source: 'healthcheck',
          status: 'error',
          taskType: 'provider_healthcheck',
          resolvedModel: { provider: probe.provider, modelId: bare.modelId, task: 'healthcheck' },
          startedAt,
          errorClass,
          errorMessage,
          metadata: { note: probe.note },
        });
      }
    }
  }
};

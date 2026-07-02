import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from './config.js';
import { withTelemetry, withFallback } from './aiMiddleware.js';

export type MuelModelTask = 'chat' | 'router' | 'extract' | 'summary' | 'heavy' | 'vision';
export type MuelModelProvider = 'gemini' | 'nvidia' | 'mindlogic';

export type ResolvedMuelModel = {
  model: any;
  provider: MuelModelProvider;
  modelId: string;
  task: MuelModelTask;
};

let googleProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let nvidiaProvider: ReturnType<typeof createOpenAICompatible> | null = null;
let mindlogicProvider: ReturnType<typeof createOpenAICompatible> | null = null;

export const normalizeGeminiModelName = (modelName: string): string =>
  modelName.replace(/^models\//, '').trim();

const getGoogleProvider = () => {
  if (!config.googleGenerativeAiApiKey) return null;
  if (!googleProvider) {
    googleProvider = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey });
  }
  return googleProvider;
};

const getNvidiaProvider = () => {
  if (!config.nvidiaApiKey) return null;
  if (!nvidiaProvider) {
    nvidiaProvider = createOpenAICompatible({
      name: 'nvidia',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: config.nvidiaApiKey,
    });
  }
  return nvidiaProvider;
};

// MindLogic(명지전문대) API Gateway — OpenAI 호환. 한 키로 OpenAI/Anthropic/Gemini 등 통합.
const getMindlogicProvider = () => {
  if (!config.mindlogicApiKey) return null;
  if (!mindlogicProvider) {
    mindlogicProvider = createOpenAICompatible({
      name: 'mindlogic',
      baseURL: 'https://factchat-cloud.mindlogic.ai/v1/gateway',
      apiKey: config.mindlogicApiKey,
    });
  }
  return mindlogicProvider;
};

export const getModelIdForTask = (task: MuelModelTask): string => {
  switch (task) {
    case 'chat':
      return config.muelChatModel;
    case 'router':
      return config.muelRouterModel;
    case 'extract':
      return config.muelExtractModel;
    case 'summary':
      return config.muelSummaryModel;
    case 'heavy':
      return config.muelHeavyModel;
    case 'vision':
      return config.muelVisionModel;
  }
};

// Gemini 실패(크레딧 고갈 등) 시 폴백할 MindLogic 게이트웨이 모델(telemetry 포함).
const buildGatewayLaneModel = (task: MuelModelTask): any => {
  const mindlogic = getMindlogicProvider();
  if (!mindlogic) return null;
  const mlId = config.mindlogicModel;
  return withTelemetry(mindlogic(mlId) as any, { provider: 'mindlogic', modelId: `mindlogic:${mlId}`, task });
};

export const getGeminiTextModel = (task: MuelModelTask): ResolvedMuelModel | null => {
  const google = getGoogleProvider();
  if (!google) return null;
  const modelId = normalizeGeminiModelName(getModelIdForTask(task));
  // ADR-003 P2a/P10 — telemetry middleware. + 전 레인 자동 폴백: Gemini 실패 시 MindLogic 게이트웨이로 투명 재시도.
  const primary = withTelemetry(google(modelId) as any, { provider: 'gemini', modelId, task });
  const gateway = buildGatewayLaneModel(task);
  return {
    model: withFallback(primary, gateway, { fromModelId: modelId, toModelId: `mindlogic:${config.mindlogicModel}`, task }),
    provider: 'gemini',
    modelId,
    task,
  };
};

export const getPrimaryTextModel = (task: MuelModelTask): ResolvedMuelModel | null => {
  return getGeminiTextModel(task) ?? getFallbackTextModel(task);
};

export const getFallbackTextModel = (task: MuelModelTask = 'heavy'): ResolvedMuelModel | null => {
  // 1순위 폴백: MindLogic 게이트웨이(OpenAI 호환, 조직 크레딧). Gemini 직접 결제가 말라도 여기로.
  const mindlogic = getMindlogicProvider();
  if (mindlogic) {
    const mlId = `mindlogic:${config.mindlogicModel}`;
    const mlModel = mindlogic(config.mindlogicModel);
    return {
      model: withTelemetry(mlModel as any, { provider: 'mindlogic', modelId: mlId, task }),
      provider: 'mindlogic',
      modelId: mlId,
      task,
    };
  }
  // 2순위 폴백: NVIDIA NIM.
  const nvidia = getNvidiaProvider();
  if (!nvidia) return null;
  const modelId = `nvidia:${config.nvidiaModel}`;
  const baseModel = nvidia(config.nvidiaModel);
  return {
    model: withTelemetry(baseModel as any, { provider: 'nvidia', modelId, task }),
    provider: 'nvidia',
    modelId,
    task,
  };
};

export const getNvidiaTextModel = (modelId: string, task: MuelModelTask): ResolvedMuelModel | null => {
  const nvidia = getNvidiaProvider();
  if (!nvidia) return null;
  const fullId = `nvidia:${modelId}`;
  const baseModel = nvidia(modelId);
  return {
    model: withTelemetry(baseModel as any, { provider: 'nvidia', modelId: fullId, task }),
    provider: 'nvidia',
    modelId: fullId,
    task,
  };
};

// chat 레인 전용: MindLogic 게이트웨이 주력 + Gemini 역방향 폴백(telemetry 포함).
// Why: 잡담/lightweight 턴의 소셜 캘리브레이션(반어·드립·답장대상 신호 활용)은 모델 체급 문제라
// chat 레인만 Sonnet 계열로 올린다. router/extract/summary 는 기계적 작업이라 Gemini flash 유지.
// 폴백 방향 주의: 기본 레인은 gemini→mindlogic 인데 여기서는 mindlogic→gemini 로 뒤집는다.
export const getMindlogicTextModel = (modelId: string, task: MuelModelTask): ResolvedMuelModel | null => {
  const mindlogic = getMindlogicProvider();
  if (!mindlogic) return null;
  const fullId = `mindlogic:${modelId}`;
  const primary = withTelemetry(mindlogic(modelId) as any, { provider: 'mindlogic', modelId: fullId, task });
  const google = getGoogleProvider();
  const geminiId = normalizeGeminiModelName(getModelIdForTask(task));
  const reverseFallback = google
    ? withTelemetry(google(geminiId) as any, { provider: 'gemini', modelId: geminiId, task })
    : null;
  return {
    model: withFallback(primary, reverseFallback, { fromModelId: fullId, toModelId: geminiId, task }),
    provider: 'mindlogic',
    modelId: fullId,
    task,
  };
};

// heavy 레인 전용: NVIDIA 주력 + Gemini 역방향 폴백 — chat 레인 mindlogic 패턴과 동일.
// getNvidiaTextModel(폴백 없음)은 getFallbackTextModel 의 2순위 레그용으로 남긴다
// (거긴 이미 gemini 가 죽은 뒤라 역방향 폴백이 무의미).
export const getNvidiaLaneModel = (task: MuelModelTask): ResolvedMuelModel | null => {
  const nvidia = getNvidiaProvider();
  if (!nvidia) return null;
  const modelId = config.nvidiaHeavyModel;
  const fullId = `nvidia:${modelId}`;
  const primary = withTelemetry(nvidia(modelId) as any, { provider: 'nvidia', modelId: fullId, task });
  const google = getGoogleProvider();
  const geminiId = normalizeGeminiModelName(getModelIdForTask(task));
  const reverseFallback = google
    ? withTelemetry(google(geminiId) as any, { provider: 'gemini', modelId: geminiId, task })
    : null;
  return {
    model: withFallback(primary, reverseFallback, { fromModelId: fullId, toModelId: geminiId, task }),
    provider: 'nvidia',
    modelId: fullId,
    task,
  };
};

// healthcheck 전용: 폴백 *없는* 단일 프로바이더 bare 모델. 프로브 성공/실패를
// 해당 프로바이더에 정확히 귀속시키기 위해 withFallback 을 일부러 안 얹는다.
export type BareProbeModel = { model: any; provider: MuelModelProvider; modelId: string };
export const getBareTextModel = (provider: MuelModelProvider, modelId: string): BareProbeModel | null => {
  switch (provider) {
    case 'gemini': {
      const google = getGoogleProvider();
      if (!google) return null;
      const id = normalizeGeminiModelName(modelId);
      return { model: withTelemetry(google(id) as any, { provider, modelId: id, task: 'healthcheck' }), provider, modelId: id };
    }
    case 'mindlogic': {
      const mindlogic = getMindlogicProvider();
      if (!mindlogic) return null;
      const fullId = `mindlogic:${modelId}`;
      return { model: withTelemetry(mindlogic(modelId) as any, { provider, modelId: fullId, task: 'healthcheck' }), provider, modelId: fullId };
    }
    case 'nvidia': {
      const nvidia = getNvidiaProvider();
      if (!nvidia) return null;
      const fullId = `nvidia:${modelId}`;
      return { model: withTelemetry(nvidia(modelId) as any, { provider, modelId: fullId, task: 'healthcheck' }), provider, modelId: fullId };
    }
  }
};

// 레인 주력 모델. heavy 레인은 MUEL_HEAVY_PROVIDER=nvidia 면 NVIDIA(예: deepseek-v4-flash)로
// 라우팅 — 단가가 Gemini 3.5-flash 보다 싸서 substantive 턴 실험용. 실패 시 Gemini 역방향 폴백.
// chat 레인은 MUEL_CHAT_PROVIDER=mindlogic 이면 MindLogic Sonnet(MINDLOGIC_CHAT_MODEL)으로
// 라우팅 — 잡담 턴 소셜 캘리브레이션 개선용. MindLogic 미가용 시 Gemini 로 폴백.
// 그 외 레인(vision 등)과 기본값은 Gemini.
export const getLaneModel = (task: MuelModelTask): ResolvedMuelModel | null => {
  if (task === 'heavy' && config.heavyProvider === 'nvidia') {
    return getNvidiaLaneModel(task) ?? getGeminiTextModel(task);
  }
  if (task === 'chat' && config.chatProvider === 'mindlogic') {
    return getMindlogicTextModel(config.mindlogicChatModel, task) ?? getGeminiTextModel(task);
  }
  return getGeminiTextModel(task);
};

export const getGoogleSearchTool = () => {
  const google = getGoogleProvider();
  if (!google) return null;
  try {
    // @ts-ignore Optional provider helper exists only in some @ai-sdk/google versions.
    return google.tools?.googleSearch?.({}) ?? null;
  } catch (error) {
    console.warn('[model-registry] failed to attach googleSearch tool', error);
    return null;
  }
};

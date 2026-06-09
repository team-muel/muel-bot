import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from './config.js';
import { withTelemetry } from './aiMiddleware.js';

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

export const getGeminiTextModel = (task: MuelModelTask): ResolvedMuelModel | null => {
  const google = getGoogleProvider();
  if (!google) return null;
  const modelId = normalizeGeminiModelName(getModelIdForTask(task));
  // ADR-003 P2a/P10 — telemetry middleware 로 모든 호출에 latency/usage 로그.
  const baseModel = google(modelId);
  return {
    model: withTelemetry(baseModel as any, { provider: 'gemini', modelId, task }),
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

// 레인 주력 모델. heavy 레인은 MUEL_HEAVY_PROVIDER=nvidia 면 NVIDIA(예: deepseek-v4-flash)로
// 라우팅 — 단가가 Gemini 3.5-flash 보다 싸서 substantive 턴 실험용. NVIDIA 미가용 시 Gemini 로 폴백.
// 그 외 레인(chat/vision 등)과 기본값은 Gemini.
export const getLaneModel = (task: MuelModelTask): ResolvedMuelModel | null => {
  if (task === 'heavy' && config.heavyProvider === 'nvidia') {
    return getNvidiaTextModel(config.nvidiaHeavyModel, task) ?? getGeminiTextModel(task);
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

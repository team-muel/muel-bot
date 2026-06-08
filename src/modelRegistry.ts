import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from './config.js';
import { withTelemetry } from './aiMiddleware.js';

export type MuelModelTask = 'chat' | 'router' | 'extract' | 'summary' | 'heavy' | 'vision';
export type MuelModelProvider = 'gemini' | 'nvidia';

export type ResolvedMuelModel = {
  model: any;
  provider: MuelModelProvider;
  modelId: string;
  task: MuelModelTask;
};

let googleProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let nvidiaProvider: ReturnType<typeof createOpenAICompatible> | null = null;

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

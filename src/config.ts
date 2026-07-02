const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const optionalEnv = (key: string): string | null => {
  return process.env[key]?.trim() || null;
};

const booleanEnv = (key: string, fallback: boolean): boolean => {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
};

// Lane defaults — chat/router/extract/summary stay on 2.5-flash for cost.
// 3.5-flash is reserved for the heavy lane (no current callers; explicit
// escalation only). MUEL_AI_MODEL still acts as the cross-lane default when a
// lane-specific env is unset; flip it once to move everything together.
const DEFAULT_LANE_MODEL = 'gemini-2.5-flash';
const DEFAULT_HEAVY_MODEL = 'gemini-2.5-flash';
// Vision lane — image-bearing turns escalate to 3.5-flash (best multimodal,
// Flash-tier cost, GA 2026-05). Text lanes stay on 2.5-flash.
const DEFAULT_VISION_MODEL = 'gemini-3.5-flash';

export const config = {
  discordBotToken: requiredEnv('DISCORD_BOT_TOKEN'),
  discordApplicationPublicKey: optionalEnv('DISCORD_APPLICATION_PUBLIC_KEY'),
  gomdoriBotToken: optionalEnv('GOMDORI_BOT_TOKEN'),
  gomdoriApplicationPublicKey: optionalEnv('GOMDORI_APPLICATION_PUBLIC_KEY'),
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: optionalEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: optionalEnv('SUPABASE_SERVICE_ROLE_KEY') ?? optionalEnv('SUPABASE_KEY'),
  googleGenerativeAiApiKey: optionalEnv('GOOGLE_GENERATIVE_AI_API_KEY') ?? optionalEnv('GEMINI_API_KEY'),
  muelAiModel: optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelChatModel: optionalEnv('MUEL_CHAT_MODEL') ?? optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelRouterModel: optionalEnv('MUEL_ROUTER_MODEL') ?? optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelExtractModel: optionalEnv('MUEL_EXTRACT_MODEL') ?? DEFAULT_HEAVY_MODEL,
  muelSummaryModel: optionalEnv('MUEL_SUMMARY_MODEL') ?? optionalEnv('MUEL_AI_MODEL') ?? DEFAULT_LANE_MODEL,
  muelHeavyModel: optionalEnv('MUEL_HEAVY_MODEL') ?? DEFAULT_HEAVY_MODEL,
  heavyProvider: (optionalEnv('MUEL_HEAVY_PROVIDER') ?? 'gemini') as 'gemini' | 'nvidia',
  muelVisionModel: optionalEnv('MUEL_VISION_MODEL') ?? DEFAULT_VISION_MODEL,
  muelEmbeddingModel: optionalEnv('MUEL_EMBEDDING_MODEL') ?? 'gemini-embedding-001',
  muelEmbeddingDimensions: Number(process.env.MUEL_EMBEDDING_DIMENSIONS ?? 768),
  nvidiaApiKey: optionalEnv('NVIDIA_API_KEY'),
  nvidiaModel: optionalEnv('NVIDIA_MODEL') ?? 'meta/llama-3.2-90b-vision-instruct',
  mindlogicApiKey: optionalEnv('MINDLOGIC_API_KEY'),
  mindlogicModel: optionalEnv('MINDLOGIC_MODEL') ?? 'gemini-2.5-flash',
  // chat 레인 프로바이더 스위치 — 잡담/lightweight 턴의 소셜 캘리브레이션(반어·드립·답장 문맥)
  // 개선용. mindlogic 이면 chat 레인만 MindLogic 게이트웨이의 Sonnet 계열로 라우팅.
  chatProvider: (optionalEnv('MUEL_CHAT_PROVIDER') ?? 'gemini') as 'gemini' | 'mindlogic',
  mindlogicChatModel: optionalEnv('MINDLOGIC_CHAT_MODEL') ?? 'claude-sonnet-5',
  nvidiaHeavyModel: optionalEnv('NVIDIA_HEAVY_MODEL') ?? 'deepseek-ai/deepseek-v4-flash',
  hubUrl: optionalEnv('HUB_URL') ?? 'https://muel-tree.vercel.app',
  youtubeMonitorIntervalMs: Number(process.env.YOUTUBE_MONITOR_INTERVAL_MS ?? 5 * 60_000),
  youtubeFetchTimeoutMs: Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS ?? 20_000),
  youtubeDataApiKey: optionalEnv('YOUTUBE_DATA_API_KEY'),
  mentionReplyTimeoutMs: Number(process.env.MENTION_REPLY_TIMEOUT_MS ?? 15_000),
  mentionImageReplyTimeoutMs: Number(process.env.MENTION_IMAGE_REPLY_TIMEOUT_MS ?? 35_000),
  spamBlockEnabled: booleanEnv('MUEL_SPAM_BLOCK_ENABLED', true),
  spamBlockMinConfidence: Number(process.env.MUEL_SPAM_BLOCK_MIN_CONFIDENCE ?? 0.75),
  enableJobWorker: booleanEnv('ENABLE_JOB_WORKER', booleanEnv('ENABLE_MEMORY_WORKER', true)),
  enableYoutubeMonitor: booleanEnv('ENABLE_YOUTUBE_MONITOR', true),
  enableHttpInteractions: booleanEnv('ENABLE_HTTP_INTERACTIONS', false),
  // AI-Q research backend (GCP Cloud Run). When AIQ_SERVER_URL is unset, the
  // enrichment button responds with a "backend not configured" message and
  // does not enqueue a job.
  aiqServerUrl: optionalEnv('AIQ_SERVER_URL'),
  aiqAuthToken: optionalEnv('AIQ_AUTH_TOKEN'),
  aiqPollIntervalMs: Number(process.env.AIQ_POLL_INTERVAL_MS ?? 5_000),
  // deep_researcher (max_loops=2) takes ~15-20 min per the AI-Q deploy notes,
  // so the previous 10 min default was guaranteed to time out. Bumped to 45 min
  // (2700s); prod showed 25 min still timed out mid-run; shallow_researcher finishes
  // in ~30s-3min and is unaffected. Override with AIQ_POLL_TIMEOUT_MS env.
  aiqPollTimeoutMs: Number(process.env.AIQ_POLL_TIMEOUT_MS ?? 45 * 60_000),
  aiqDefaultAgentType: optionalEnv('AIQ_DEFAULT_AGENT_TYPE') ?? 'deep_researcher',
  aiqTopicMaxChars: Number(process.env.AIQ_TOPIC_MAX_CHARS ?? 2_000),
  aiqEnabled: booleanEnv('AIQ_ENABLED', true),
};

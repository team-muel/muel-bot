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

export const config = {
  discordBotToken: requiredEnv('DISCORD_BOT_TOKEN'),
  discordApplicationPublicKey: optionalEnv('DISCORD_APPLICATION_PUBLIC_KEY'),
  gomdoriBotToken: optionalEnv('GOMDORI_BOT_TOKEN'),
  gomdoriApplicationPublicKey: optionalEnv('GOMDORI_APPLICATION_PUBLIC_KEY'),
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: optionalEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: optionalEnv('SUPABASE_SERVICE_ROLE_KEY') ?? optionalEnv('SUPABASE_KEY'),
  googleGenerativeAiApiKey: optionalEnv('GOOGLE_GENERATIVE_AI_API_KEY') ?? optionalEnv('GEMINI_API_KEY'),
  muelAiModel: optionalEnv('MUEL_AI_MODEL') ?? 'gemini-2.5-flash',
  muelEmbeddingModel: optionalEnv('MUEL_EMBEDDING_MODEL') ?? 'gemini-embedding-001',
  muelEmbeddingDimensions: Number(process.env.MUEL_EMBEDDING_DIMENSIONS ?? 768),
  nvidiaApiKey: optionalEnv('NVIDIA_API_KEY'),
  nvidiaModel: optionalEnv('NVIDIA_MODEL') ?? 'meta/llama-3.3-70b-instruct',
  hubUrl: optionalEnv('HUB_URL') ?? 'https://muel-tree.vercel.app',
  youtubeMonitorIntervalMs: Number(process.env.YOUTUBE_MONITOR_INTERVAL_MS ?? 5 * 60_000),
  youtubeFetchTimeoutMs: Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS ?? 20_000),
  mentionReplyTimeoutMs: Number(process.env.MENTION_REPLY_TIMEOUT_MS ?? 15_000),
  enableJobWorker: booleanEnv('ENABLE_JOB_WORKER', booleanEnv('ENABLE_MEMORY_WORKER', true)),
  enableYoutubeMonitor: booleanEnv('ENABLE_YOUTUBE_MONITOR', true),
  enableHttpInteractions: booleanEnv('ENABLE_HTTP_INTERACTIONS', false),
};

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

export const config = {
  discordBotToken: requiredEnv('DISCORD_BOT_TOKEN'),
  gomdoriBotToken: optionalEnv('GOMDORI_BOT_TOKEN'),
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: optionalEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: optionalEnv('SUPABASE_SERVICE_ROLE_KEY') ?? optionalEnv('SUPABASE_KEY'),
  googleGenerativeAiApiKey: optionalEnv('GOOGLE_GENERATIVE_AI_API_KEY') ?? optionalEnv('GEMINI_API_KEY'),
  muelAiModel: optionalEnv('MUEL_AI_MODEL') ?? 'gemini-1.5-flash',
  muelEmbeddingModel: optionalEnv('MUEL_EMBEDDING_MODEL') ?? 'gemini-embedding-001',
  muelEmbeddingDimensions: Number(process.env.MUEL_EMBEDDING_DIMENSIONS ?? 768),
  nvidiaApiKey: optionalEnv('NVIDIA_API_KEY'),
  nvidiaModel: optionalEnv('NVIDIA_MODEL') ?? 'meta/llama-3.3-70b-instruct',
  hubUrl: optionalEnv('HUB_URL') ?? 'https://muel-tree.vercel.app',
  youtubeMonitorIntervalMs: Number(process.env.YOUTUBE_MONITOR_INTERVAL_MS ?? 5 * 60_000),
  youtubeFetchTimeoutMs: Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS ?? 20_000),
};

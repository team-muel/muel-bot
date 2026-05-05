const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config = {
  discordBotToken: requiredEnv('DISCORD_BOT_TOKEN'),
  supabaseUrl: requiredEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  youtubeMonitorIntervalMs: 5 * 60_000,
  youtubeFetchTimeoutMs: 20_000,
};

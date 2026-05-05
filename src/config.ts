const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config = {
  discordBotToken: requiredEnv('DISCORD_BOT_TOKEN'),
  port: Number(process.env.PORT ?? 3000),
};

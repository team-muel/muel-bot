export type DiscordConnectionState = {
  readyAt: string | null;
  loginError: string | null;
};

export const createDiscordConnectionState = (): DiscordConnectionState => ({
  readyAt: null,
  loginError: null,
});

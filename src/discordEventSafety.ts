import type { Client, ClientEvents } from 'discord.js';

export type DiscordEventErrorLogger = (eventName: string, error: unknown) => void;

export const safeDiscordEvent = async (
  eventName: string,
  handler: () => Promise<unknown> | unknown,
  logError: DiscordEventErrorLogger = (name, error) => {
    console.error('[discord-event] handler failed', { eventName: name, error });
  },
): Promise<void> => {
  try {
    await handler();
  } catch (error) {
    logError(eventName, error);
  }
};

export const onSafeDiscordEvent = <Event extends keyof ClientEvents>(
  client: Client,
  eventName: Event,
  handler: (...args: ClientEvents[Event]) => Promise<unknown> | unknown,
): void => {
  client.on(eventName, (...args) => {
    void safeDiscordEvent(String(eventName), () => handler(...args));
  });
};

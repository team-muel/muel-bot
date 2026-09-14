import type { Client } from 'discord.js';
import {
  buildGomdoriGlobalCommands,
  registerGomdoriCommands,
} from './discordCommandRegistry.js';

export type GomdoriCommandRegistrationStatus = {
  lastRegisteredAt: string | null;
  registered: string[];
  lastError: string | null;
};

const status: GomdoriCommandRegistrationStatus = {
  lastRegisteredAt: null,
  registered: [],
  lastError: null,
};

export const registerTrackedGomdoriCommands = async (
  readyClient: Client<true>,
  botToken: string,
): Promise<void> => {
  const intended = buildGomdoriGlobalCommands().map((command) => command.name);
  try {
    await registerGomdoriCommands(readyClient, botToken);
    status.lastRegisteredAt = new Date().toISOString();
    status.registered = intended;
    status.lastError = null;
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : String(error);
    console.error('[gomdori] command registration failed', { intended, error });
    throw error;
  }
};

export const getGomdoriCommandRegistrationStatus = (): GomdoriCommandRegistrationStatus => ({
  ...status,
  registered: [...status.registered],
});

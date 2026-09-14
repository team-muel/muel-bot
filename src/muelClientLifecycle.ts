import { Client, Events } from 'discord.js';
import { config } from './config.js';
import { registerMuelCommands } from './discordCommandRegistry.js';
import { startRuntimeServices } from './runtimeServices.js';
import { onceSafeDiscordEvent } from './discordEventSafety.js';
import type { DiscordConnectionState } from './discordRuntimeState.js';

export const registerMuelClientLifecycle = (
  client: Client,
  connection: DiscordConnectionState,
): void => {
  onceSafeDiscordEvent(client, Events.ClientReady, async (readyClient) => {
    connection.readyAt = new Date().toISOString();
    console.log(`[discord] online as ${readyClient.user.tag}`);

    await startRuntimeServices(readyClient);

    if (config.registerDiscordCommandsOnReady) {
      try {
        await registerMuelCommands(readyClient);
      } catch (error) {
        console.error('[discord] command registration failed', error);
      }
    } else {
      console.info('[discord] automatic command registration disabled');
    }
  });

  client.on(Events.Error, (error) => {
    console.error('[discord] client error', error);
  });
};

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { registerTrackedGomdoriCommands } from './gomdoriCommandRegistry.js';
import {
  CODEX_COMMAND_NAME,
  handleCodexCommand,
  handleCodexSelect,
  isCodexSelect,
} from './gomdoriCodexHandler.js';
import { onSafeDiscordEvent, onceSafeDiscordEvent } from './discordEventSafety.js';
import type { DiscordConnectionState } from './discordRuntimeState.js';

export const createGomdoriClient = (): Client | null => (
  config.gomdoriBotToken
    ? new Client({ intents: [GatewayIntentBits.Guilds] })
    : null
);

export const registerGomdoriClientRuntime = (
  client: Client,
  connection: DiscordConnectionState,
): void => {
  onceSafeDiscordEvent(client, Events.ClientReady, async (readyClient) => {
    connection.readyAt = new Date().toISOString();
    console.log(`[gomdori] online as ${readyClient.user.tag}`);

    if (config.registerDiscordCommandsOnReady) {
      try {
        await registerTrackedGomdoriCommands(readyClient, config.gomdoriBotToken!);
        console.log('[gomdori] replaced global commands');
      } catch (error) {
        console.error('[gomdori] command registration failed', error);
      }
    } else {
      console.info('[gomdori] automatic command registration disabled');
    }
  });

  if (!config.enableHttpInteractions) {
    onSafeDiscordEvent(client, Events.InteractionCreate, async (interaction) => {
      if (interaction.isStringSelectMenu()) {
        if (isCodexSelect(interaction.customId)) {
          await handleCodexSelect(interaction);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'ping') {
        await interaction.reply({ content: 'pong 🐻', flags: [MessageFlags.Ephemeral] });
        return;
      }
      if (interaction.commandName === CODEX_COMMAND_NAME) {
        await handleCodexCommand(interaction);
      }
    });
  }

  client.on(Events.Error, (error) => {
    console.error('[gomdori] client error', error);
  });
};

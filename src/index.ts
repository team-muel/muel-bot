import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { startRuntimeHttpServer } from './runtimeHttpServer.js';
import { buildRuntimeStatus, collectRuntimeStatus } from './runtimeStatus.js';
import { observeDiscordConnection, usePublicDiscordGateway } from './discordConnection.js';
import {
  createDiscordConnectionState,
} from './discordRuntimeState.js';
import { registerMuelClientLifecycle } from './muelClientLifecycle.js';
import { registerMuelInteractionEvents } from './muelInteractionEvents.js';
import { registerMuelMessageEvents } from './muelMessageEvents.js';
import {
  createGomdoriClient,
  registerGomdoriClientRuntime,
} from './gomdoriClientRuntime.js';

const muelConnection = createDiscordConnectionState();
const gomdoriConnection = createDiscordConnectionState();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const gomdoriClient = createGomdoriClient();

registerMuelClientLifecycle(client, muelConnection);
registerMuelInteractionEvents(client);
registerMuelMessageEvents(client);
if (gomdoriClient) registerGomdoriClientRuntime(gomdoriClient, gomdoriConnection);

startRuntimeHttpServer({
  client,
  gomdoriClient,
  getRuntimeStatus: () => buildRuntimeStatus(collectRuntimeStatus({
    muelReady: client.isReady(),
    muelLoginError: muelConnection.loginError,
    gomdoriConfigured: Boolean(gomdoriClient && config.gomdoriBotToken),
    gomdoriReady: !gomdoriClient || gomdoriClient.isReady(),
    gomdoriLoginError: gomdoriConnection.loginError,
  })),
  getMuelConnectionStatus: () => ({ ...muelConnection }),
  getGomdoriConnectionStatus: () => ({ ...gomdoriConnection }),
});

usePublicDiscordGateway(client, 'muel');
observeDiscordConnection(client, 'muel');
client.login(config.discordBotToken).catch((error: unknown) => {
  muelConnection.loginError = error instanceof Error ? error.message : String(error);
  console.error('[discord] login failed', error);
});

if (gomdoriClient && config.gomdoriBotToken) {
  usePublicDiscordGateway(gomdoriClient, 'gomdori');
  observeDiscordConnection(gomdoriClient, 'gomdori');
  gomdoriClient.login(config.gomdoriBotToken).catch((error: unknown) => {
    gomdoriConnection.loginError = error instanceof Error ? error.message : String(error);
    console.error('[gomdori] login failed', error);
  });
}

import http from 'node:http';
import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

let readyAt: string | null = null;
let loginError: string | null = null;

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  readyAt = new Date().toISOString();
  console.log(`[discord] online as ${readyClient.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  await rest.put(Routes.applicationCommands(readyClient.application.id), {
    body: [pingCommand.toJSON()],
  });
  console.log('[discord] registered /ping');
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: 'pong', ephemeral: true });
  }
});

client.on(Events.Error, (error) => {
  console.error('[discord] client error', error);
});

const server = http.createServer((_, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ok: true,
    bot: client.user?.tag ?? null,
    readyAt,
    loginError,
    wsStatus: client.ws.status,
    uptimeSeconds: Math.floor(process.uptime()),
  }));
});

server.listen(config.port, () => {
  console.log(`[http] listening on ${config.port}`);
});

client.login(config.discordBotToken).catch((error: unknown) => {
  loginError = error instanceof Error ? error.message : String(error);
  console.error('[discord] login failed', error);
});

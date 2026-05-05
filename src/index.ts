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

const registerCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands = [pingCommand.toJSON()];

  await rest.put(Routes.applicationCommands(readyClient.application.id), {
    body: commands,
  });
  console.log('[discord] registered global /ping');

  for (const guild of readyClient.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(readyClient.application.id, guild.id), {
      body: commands,
    });
    console.log(`[discord] reset guild commands for ${guild.id}`);
  }
};

client.once(Events.ClientReady, async (readyClient) => {
  readyAt = new Date().toISOString();
  console.log(`[discord] online as ${readyClient.user.tag}`);

  await registerCommands(readyClient);
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

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('OK');
    return;
  }

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

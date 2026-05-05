import http from 'node:http';
import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

let readyAt: string | null = null;
let loginError: string | null = null;

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const helpCommand = new SlashCommandBuilder()
  .setName('도움말')
  .setDescription('Muel에서 사용할 수 있는 입구를 안내합니다.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const registerCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands = [helpCommand.toJSON(), pingCommand.toJSON()];

  await rest.put(Routes.applicationCommands(readyClient.application.id), {
    body: commands,
  });
  console.log('[discord] replaced global commands');

  for (const guild of readyClient.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(readyClient.application.id, guild.id), {
      body: [],
    });
    console.log(`[discord] cleared guild commands for ${guild.id}`);
  }
};

client.once(Events.ClientReady, async (readyClient) => {
  readyAt = new Date().toISOString();
  console.log(`[discord] online as ${readyClient.user.tag}`);

  try {
    await registerCommands(readyClient);
  } catch (error) {
    loginError = error instanceof Error ? error.message : String(error);
    console.error('[discord] command registration failed', error);
  }

});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: 'pong', ephemeral: true });
    return;
  }

  if (interaction.commandName === '도움말') {
    await interaction.reply({
      content: [
        'Muel에서 사용할 수 있는 입구입니다.',
        '',
        `Muel Hub: ${config.hubUrl}`,
        `Weave: ${config.hubUrl}/weave`,
        '',
        'Gomdori와 Server는 준비 중입니다.',
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: [
      '지금 사용할 수 있는 명령어는 /도움말 과 /ping 입니다.',
      config.hubUrl,
    ].join('\n'),
    ephemeral: true,
  });
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

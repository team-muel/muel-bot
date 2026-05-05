import http from 'node:http';
import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { handleGroupedSubscribeCommand } from './subscribe.js';

let readyAt: string | null = null;
let loginError: string | null = null;

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const subscribeCommand = new SlashCommandBuilder()
  .setName('구독')
  .setDescription('YouTube 채널 게시글/영상 구독을 관리합니다.')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('현재 Discord 채널에 YouTube 구독을 추가합니다.')
      .addStringOption((option) =>
        option
          .setName('종류')
          .setDescription('구독할 YouTube 항목')
          .setRequired(true)
          .addChoices(
            { name: '게시글', value: 'posts' },
            { name: '영상', value: 'videos' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('링크')
          .setDescription('YouTube 채널 URL 또는 UC... 채널 ID')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('현재 Discord 채널의 YouTube 구독을 해제합니다.')
      .addStringOption((option) =>
        option
          .setName('종류')
          .setDescription('해제할 YouTube 항목')
          .setRequired(true)
          .addChoices(
            { name: '게시글', value: 'posts' },
            { name: '영상', value: 'videos' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('링크')
          .setDescription('YouTube 채널 URL 또는 UC... 채널 ID')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('이 서버의 YouTube 구독 목록을 봅니다.'),
  );

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const registerCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands = [pingCommand.toJSON(), subscribeCommand.toJSON()];

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

  if (interaction.commandName === '구독') {
    await handleGroupedSubscribeCommand(interaction);
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

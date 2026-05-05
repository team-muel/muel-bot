import http from 'node:http';
import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { handleGroupedSubscribeCommand, OPTION_KIND, OPTION_LINK, SUBSCRIBE_COMMAND_NAME } from './subscribe.js';
import { getYouTubeMonitorStatus, startYouTubeMonitor } from './youtubeMonitor.js';

let readyAt: string | null = null;
let loginError: string | null = null;

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const helpCommand = new SlashCommandBuilder()
  .setName('도움말')
  .setDescription('Muel 허브 사이트를 엽니다.');

const subscribeCommand = new SlashCommandBuilder()
  .setName(SUBSCRIBE_COMMAND_NAME)
  .setDescription('Manage YouTube post/video subscriptions.')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Subscribe the current Discord channel to a YouTube channel.')
      .addStringOption((option) =>
        option
          .setName(OPTION_KIND)
          .setDescription('YouTube subscription type.')
          .setRequired(true)
          .addChoices(
            { name: '\uac8c\uc2dc\uae00', value: 'posts' },
            { name: '\uc601\uc0c1', value: 'videos' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName(OPTION_LINK)
          .setDescription('YouTube channel URL or UC channel ID.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a YouTube subscription from the current Discord channel.')
      .addStringOption((option) =>
        option
          .setName(OPTION_KIND)
          .setDescription('YouTube subscription type.')
          .setRequired(true)
          .addChoices(
            { name: '\uac8c\uc2dc\uae00', value: 'posts' },
            { name: '\uc601\uc0c1', value: 'videos' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName(OPTION_LINK)
          .setDescription('YouTube channel URL or UC channel ID.')
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List YouTube subscriptions for this server.'),
  );

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const registerCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands = [pingCommand.toJSON(), helpCommand.toJSON(), subscribeCommand.toJSON()];
  const allowedCommandNames = new Set(commands.map((command) => command.name));
  const primaryEntryPointType = 4;

  const existingGlobalCommands = await rest.get(Routes.applicationCommands(readyClient.application.id)) as Array<{
    id: string;
    name: string;
    type?: number;
  }>;

  for (const command of commands) {
    await rest.post(Routes.applicationCommands(readyClient.application.id), {
      body: command,
    });
  }

  for (const command of existingGlobalCommands) {
    if (!allowedCommandNames.has(command.name) && command.type !== primaryEntryPointType) {
      await rest.delete(Routes.applicationCommand(readyClient.application.id, command.id));
      console.log(`[discord] deleted legacy global command ${command.name}`);
    }
  }

  console.log('[discord] registered global commands');

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

  startYouTubeMonitor(readyClient);
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
        'Muel 허브 사이트에서 챗봇과 Activity를 확인할 수 있어요.',
        config.hubUrl,
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === SUBSCRIBE_COMMAND_NAME) {
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
    youtubeMonitor: getYouTubeMonitorStatus(),
  }));
});

server.listen(config.port, () => {
  console.log(`[http] listening on ${config.port}`);
});

client.login(config.discordBotToken).catch((error: unknown) => {
  loginError = error instanceof Error ? error.message : String(error);
  console.error('[discord] login failed', error);
});

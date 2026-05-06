import http from 'node:http';
import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import {
  handleFlatSubscribeCommand,
  OPTION_ACTION,
  OPTION_KIND,
  OPTION_LINK,
  SUBSCRIBE_ACTION_ADD,
  SUBSCRIBE_ACTION_LIST,
  SUBSCRIBE_ACTION_REMOVE,
  SUBSCRIBE_COMMAND_NAME,
} from './subscribe.js';
import { getYouTubeMonitorStatus, startYouTubeMonitor } from './youtubeMonitor.js';
import { handleMuelMention } from './mentionHandler.js';
import { pushMessage } from './channelBuffer.js';

let readyAt: string | null = null;
let loginError: string | null = null;
let gomdoriReadyAt: string | null = null;
let gomdoriLoginError: string | null = null;

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const helpCommand = new SlashCommandBuilder()
  .setName('도움말')
  .setDescription('Muel에서 사용할 수 있는 입구를 안내합니다.');

const diaryCommand = new SlashCommandBuilder()
  .setName('일기')
  .setDescription('꿈을 기록하고 연결합니다.');

const diaryEntryPointCommand = {
  name: '일기',
  description: '꿈을 기록하고 연결합니다.',
  type: 4,
  handler: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const subscribeCommand = new SlashCommandBuilder()
  .setName(SUBSCRIBE_COMMAND_NAME)
  .setDescription('영상/게시글/뉴스 자동 구독을 관리합니다.')
  .addStringOption((option) =>
    option
      .setName(OPTION_ACTION)
      .setDescription('조회 / 추가 / 제거')
      .setRequired(true)
      .addChoices(
        { name: '조회', value: SUBSCRIBE_ACTION_LIST },
        { name: '추가', value: SUBSCRIBE_ACTION_ADD },
        { name: '제거', value: SUBSCRIBE_ACTION_REMOVE },
      ),
  )
  .addStringOption((option) =>
    option
      .setName(OPTION_KIND)
      .setDescription('영상 또는 게시글')
      .setRequired(false)
      .addChoices(
        { name: '영상', value: 'videos' },
        { name: '게시글', value: 'posts' },
      ),
  )
  .addStringOption((option) =>
    option
      .setName(OPTION_LINK)
      .setDescription('YouTube 채널 링크 또는 UC 채널 ID')
      .setRequired(false),
  );

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const registerCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands = [
    helpCommand.toJSON(),
    diaryCommand.toJSON(),
    subscribeCommand.toJSON(),
    pingCommand.toJSON(),
    diaryEntryPointCommand,
  ];

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

  startYouTubeMonitor(readyClient);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isPrimaryEntryPointCommand()) {
    await interaction.launchActivity();
    return;
  }

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
        `일기: ${config.hubUrl}/weave`,
        '/일기: 꿈을 기록하고 연결하기',
        '/구독: YouTube 영상/게시글 자동 구독 관리',
        '',
        `Server: https://discord.gg/NdBHcbXpjh`,
        'Gomdori는 준비 중입니다.',
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === '일기') {
    const activityUrl = `${config.hubUrl}/weave`;
    await interaction.reply({
      content: [
        '📖 일기 — 꿈을 기록하고, 다른 꿈과 연결합니다.',
        '',
        `지금 바로 시작하기: ${activityUrl}`,
        '',
        'Discord Activity에서 열면 인증 없이 바로 저장할 수 있어요.',
      ].join('\n'),
      ephemeral: false,
    });
    return;
  }

  if (interaction.commandName === SUBSCRIBE_COMMAND_NAME) {
    await handleFlatSubscribeCommand(interaction);
    return;
  }

  await interaction.reply({
    content: [
      '지금 사용할 수 있는 명령어는 /도움말, /일기, /구독, /ping 입니다.',
      config.hubUrl,
    ].join('\n'),
    ephemeral: true,
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (!client.isReady()) {
    return;
  }

  await handleMuelMention(client, message);

  if (!message.author.bot && message.content) {
    pushMessage(message.channelId, {
      authorId: message.author.id,
      authorName: message.author.displayName ?? message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
    });
  }
});

client.on(Events.Error, (error) => {
  console.error('[discord] client error', error);
});

// --- Gomdori client (optional) ---

const gomdoriClient = config.gomdoriBotToken
  ? new Client({ intents: [GatewayIntentBits.Guilds] })
  : null;

if (gomdoriClient) {
  const gomdoriGameCommand = new SlashCommandBuilder()
    .setName('게임')
    .setDescription('Gomdori 게임을 시작합니다.');

  const gomdoriPingCommand = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether Gomdori Bot is online.');

  gomdoriClient.once(Events.ClientReady, async (readyGomdori) => {
    gomdoriReadyAt = new Date().toISOString();
    console.log(`[gomdori] online as ${readyGomdori.user.tag}`);

    try {
      const rest = new REST({ version: '10' }).setToken(config.gomdoriBotToken!);
      await rest.put(Routes.applicationCommands(readyGomdori.application.id), {
        body: [gomdoriGameCommand.toJSON(), gomdoriPingCommand.toJSON()],
      });
      console.log('[gomdori] replaced global commands');
    } catch (error) {
      gomdoriLoginError = error instanceof Error ? error.message : String(error);
      console.error('[gomdori] command registration failed', error);
    }
  });

  gomdoriClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'pong 🐻', ephemeral: true });
      return;
    }

    if (interaction.commandName === '게임') {
      await interaction.reply({
        content: [
          '🐻 Gomdori — 마피아 게임',
          '',
          `${config.hubUrl}/game`,
          '',
          '준비 중입니다.',
        ].join('\n'),
        ephemeral: false,
      });
      return;
    }
  });

  gomdoriClient.on(Events.Error, (error) => {
    console.error('[gomdori] client error', error);
  });
}

// --- HTTP server ---

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('OK');
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ok: true,
    muel: {
      bot: client.user?.tag ?? null,
      readyAt,
      loginError,
      wsStatus: client.ws.status,
    },
    gomdori: gomdoriClient
      ? {
          bot: gomdoriClient.user?.tag ?? null,
          readyAt: gomdoriReadyAt,
          loginError: gomdoriLoginError,
          wsStatus: gomdoriClient.ws.status,
        }
      : null,
    uptimeSeconds: Math.floor(process.uptime()),
    youtubeMonitor: getYouTubeMonitorStatus(),
  }));
});

server.listen(config.port, () => {
  console.log(`[http] listening on ${config.port}`);
});

// --- Login ---

client.login(config.discordBotToken).catch((error: unknown) => {
  loginError = error instanceof Error ? error.message : String(error);
  console.error('[discord] login failed', error);
});

if (gomdoriClient && config.gomdoriBotToken) {
  gomdoriClient.login(config.gomdoriBotToken).catch((error: unknown) => {
    gomdoriLoginError = error instanceof Error ? error.message : String(error);
    console.error('[gomdori] login failed', error);
  });
}

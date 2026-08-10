import {
  Client,
  REST,
  Routes,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import { config } from './config.js';
import {
  OPTION_ACTION,
  OPTION_KIND,
  OPTION_LINK,
  SUBSCRIBE_ACTION_ADD,
  SUBSCRIBE_ACTION_LIST,
  SUBSCRIBE_ACTION_REMOVE,
  SUBSCRIBE_COMMAND_NAME,
} from './subscribe.js';
import { buildHubSlashCommand } from './conciergeHandler.js';
import { buildMemoSlashCommand } from './memoHandler.js';
import { buildRollingSlashCommand } from './rollingPaperHandler.js';
import { buildWelcomeSlashCommand } from './welcomeHandler.js';
import {
  ARCHIVE_POLICY_COMMAND_NAME,
  buildArchivePolicyCommand,
} from './archivist/policy.js';
import { buildCodexSlashCommand } from './gomdoriCodexHandler.js';

export type CommandRegistrationStatus = {
  lastRegisteredAt: string | null;
  registered: string[];
  lastError: string | null;
  legacyGuildCleanup: {
    lastCleanedAt: string | null;
    cleaned: string[];
  };
};

// discord-api-types currently omits the optional description accepted by
// Discord for primary entry-point commands. Keep the wire contract explicit
// without weakening the rest of the registry to `any`.
type PrimaryEntryPointCommand = {
  name: string;
  description: string;
  type: 4;
  handler: 2;
  integration_types: [0, 1];
  contexts: [0, 1, 2];
};

type ApplicationCommandPayload =
  | RESTPostAPIApplicationCommandsJSONBody
  | PrimaryEntryPointCommand;

const registrationStatus: CommandRegistrationStatus = {
  lastRegisteredAt: null,
  registered: [],
  lastError: null,
  legacyGuildCleanup: {
    lastCleanedAt: null,
    cleaned: [],
  },
};

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('내가 깨어 있는지 확인.');

const helpCommand = new SlashCommandBuilder()
  .setName('도움말')
  .setDescription('내가 뭘 할 수 있는지 알려줄게.');

const subscribeCommand = new SlashCommandBuilder()
  .setName(SUBSCRIBE_COMMAND_NAME)
  .setDescription('YouTube 보는 뮤엘')
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

const withEveryDiscordContext = (
  command: RESTPostAPIApplicationCommandsJSONBody,
): RESTPostAPIApplicationCommandsJSONBody => ({
  ...command,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
});

export const LEGACY_GUILD_HUB_COMMAND_NAMES = new Set([
  '허브활성화',
  '허브비활성화',
  '허브목록',
  '허브상태',
  '허브-활성화',
  '허브-비활성화',
  '허브-목록',
  '허브-상태',
  '허브_활성화',
  '허브_비활성화',
  '허브_목록',
  '허브_상태',
  'hub-activate',
  'hub-deactivate',
  'hub-list',
  'hub-status',
  '일기',
]);

export const buildMuelGlobalCommands = (): ApplicationCommandPayload[] => [
  helpCommand.toJSON(),
  withEveryDiscordContext(subscribeCommand.toJSON()),
  pingCommand.toJSON(),
  withEveryDiscordContext(buildMemoSlashCommand().toJSON()),
  buildHubSlashCommand(),
  buildRollingSlashCommand().toJSON(),
  buildWelcomeSlashCommand().toJSON(),
  {
    name: '뮤엘',
    description: '내가 보는 우리',
    type: 4,
    handler: 2,
    integration_types: [0, 1],
    contexts: [0, 1, 2],
  },
];

export const buildGomdoriGlobalCommands = (): ApplicationCommandPayload[] => [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether Gomdori Bot is online.')
    .toJSON(),
  {
    name: '게임',
    description: 'Gomdori 게임을 시작합니다.',
    type: 4,
    handler: 2,
    integration_types: [0, 1],
    contexts: [0, 1, 2],
  },
  buildCodexSlashCommand().toJSON(),
];

const cleanupLegacyGuildCommands = async (
  readyClient: Client<true>,
  rest: REST,
): Promise<void> => {
  const cleanedNames: string[] = [];
  let guilds: Array<{ id: string }>;

  try {
    const guildManager = await readyClient.guilds.fetch();
    guilds = [...guildManager.values()];
  } catch (error) {
    console.warn('[discord] guilds.fetch failed, fallback to cache', error);
    guilds = [...readyClient.guilds.cache.values()];
  }

  for (const guild of guilds) {
    try {
      const rows = await rest.get(
        Routes.applicationGuildCommands(readyClient.application.id, guild.id),
      );
      if (!Array.isArray(rows)) continue;

      for (const row of rows as Array<{ id?: string; name?: string }>) {
        if (!row.id || !row.name || !LEGACY_GUILD_HUB_COMMAND_NAMES.has(row.name)) continue;
        await rest.delete(
          Routes.applicationGuildCommand(readyClient.application.id, guild.id, row.id),
        );
        cleanedNames.push(`${guild.id}:${row.name}`);
      }
    } catch (error) {
      console.warn('[discord] legacy guild command cleanup failed', {
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (cleanedNames.length > 0) {
    registrationStatus.legacyGuildCleanup = {
      lastCleanedAt: new Date().toISOString(),
      cleaned: cleanedNames,
    };
    console.log('[discord] cleaned legacy guild commands', {
      count: cleanedNames.length,
      names: cleanedNames,
    });
  } else {
    console.log('[discord] no legacy guild commands found', { scannedGuilds: guilds.length });
  }
};

const cleanupLegacyGlobalCommands = async (
  readyClient: Client<true>,
  rest: REST,
): Promise<void> => {
  try {
    const rows = await rest.get(Routes.applicationCommands(readyClient.application.id));
    if (!Array.isArray(rows)) return;

    const cleanedNames: string[] = [];
    for (const row of rows as Array<{ id?: string; name?: string }>) {
      if (!row.id || !row.name || !LEGACY_GUILD_HUB_COMMAND_NAMES.has(row.name)) continue;
      await rest.delete(Routes.applicationCommand(readyClient.application.id, row.id));
      cleanedNames.push(row.name);
    }
    if (cleanedNames.length > 0) {
      console.log('[discord] cleaned legacy global commands', {
        count: cleanedNames.length,
        names: cleanedNames,
      });
    }
  } catch (error) {
    console.warn('[discord] legacy global command cleanup failed', error);
  }
};

export const registerMuelCommands = async (readyClient: Client<true>): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  const commands = buildMuelGlobalCommands();
  const intendedNames = commands.map((command) => command.name);
  console.log('[discord] registering global commands', {
    count: commands.length,
    names: intendedNames,
  });

  try {
    await cleanupLegacyGlobalCommands(readyClient, rest);
    const result = await rest.put(Routes.applicationCommands(readyClient.application.id), {
      body: commands,
    });
    const registeredNames = Array.isArray(result)
      ? (result as Array<{ name?: string }>).flatMap((row) => row.name ? [row.name] : [])
      : [];
    registrationStatus.lastRegisteredAt = new Date().toISOString();
    registrationStatus.registered = registeredNames.length > 0 ? registeredNames : intendedNames;
    registrationStatus.lastError = null;
    console.log('[discord] replaced global commands', {
      attempted: intendedNames,
      registered: registeredNames,
      note: 'Discord 글로벌 명령은 client UI 캐시 갱신에 최대 1시간까지 걸릴 수 있음',
    });

    await cleanupLegacyGuildCommands(readyClient, rest);
    if (config.ownedGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(readyClient.application.id, config.ownedGuildId),
        { body: [buildArchivePolicyCommand()] },
      );
      console.log('[archivist] replaced owned-guild commands', {
        guildId: config.ownedGuildId,
        commands: [ARCHIVE_POLICY_COMMAND_NAME],
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    registrationStatus.lastError = detail;
    console.error('[discord] command registration failed', {
      attempted: intendedNames,
      detail,
      responseBody: (error as { rawError?: unknown }).rawError,
    });
    throw error;
  }
};

export const registerGomdoriCommands = async (
  readyClient: Client<true>,
  botToken: string,
): Promise<void> => {
  const rest = new REST({ version: '10' }).setToken(botToken);
  await rest.put(Routes.applicationCommands(readyClient.application.id), {
    body: buildGomdoriGlobalCommands(),
  });
};

export const getCommandRegistrationStatus = (): CommandRegistrationStatus => ({
  ...registrationStatus,
  registered: [...registrationStatus.registered],
  legacyGuildCleanup: {
    ...registrationStatus.legacyGuildCleanup,
    cleaned: [...registrationStatus.legacyGuildCleanup.cleaned],
  },
});

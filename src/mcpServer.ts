import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { REST, Routes } from 'discord.js';
import { z } from 'zod';
import { config } from './config.js';

type DiscordApplication = {
  id: string;
  name?: string;
  bot?: {
    id?: string;
    username?: string;
    discriminator?: string;
  };
};

const rest = new REST({ version: '10' }).setToken(config.discordBotToken);

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function compactCommand(command: Record<string, unknown>) {
  return {
    id: command.id,
    name: command.name,
    description: command.description,
    type: command.type,
    version: command.version,
  };
}

async function getApplicationId(inputApplicationId?: string | null): Promise<string> {
  if (inputApplicationId) return inputApplicationId;
  const envApplicationId = process.env.DISCORD_APPLICATION_ID?.trim();
  if (envApplicationId) return envApplicationId;

  const application = (await rest.get(
    Routes.oauth2CurrentApplication(),
  )) as DiscordApplication;

  return application.id;
}

const commandSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    type: z.number().int().optional(),
  })
  .passthrough();

const server = new McpServer({
  name: 'muel-discord',
  version: '0.1.0',
});

server.registerTool(
  'get_current_application',
  {
    title: 'Get current Discord application',
    description: 'Return the Discord application attached to DISCORD_BOT_TOKEN.',
  },
  async () => {
    const application = await rest.get(Routes.oauth2CurrentApplication());
    return jsonContent(application);
  },
);

server.registerTool(
  'list_guilds',
  {
    title: 'List bot guilds',
    description: 'List Discord servers where the bot is installed.',
  },
  async () => {
    const guilds = await rest.get(Routes.userGuilds());
    return jsonContent(guilds);
  },
);

server.registerTool(
  'list_global_commands',
  {
    title: 'List global commands',
    description: 'List global slash commands for the application.',
    inputSchema: {
      applicationId: z.string().optional(),
    },
  },
  async ({ applicationId }) => {
    const appId = await getApplicationId(applicationId);
    const commands = (await rest.get(Routes.applicationCommands(appId))) as Record<
      string,
      unknown
    >[];
    return jsonContent(commands.map(compactCommand));
  },
);

server.registerTool(
  'list_guild_commands',
  {
    title: 'List guild commands',
    description: 'List guild-scoped commands for one Discord server.',
    inputSchema: {
      guildId: z.string().min(1),
      applicationId: z.string().optional(),
    },
  },
  async ({ guildId, applicationId }) => {
    const appId = await getApplicationId(applicationId);
    const commands = (await rest.get(
      Routes.applicationGuildCommands(appId, guildId),
    )) as Record<string, unknown>[];
    return jsonContent(commands.map(compactCommand));
  },
);

server.registerTool(
  'upsert_global_command',
  {
    title: 'Upsert global command',
    description: 'Create or overwrite one global application command by name.',
    inputSchema: {
      command: commandSchema,
      applicationId: z.string().optional(),
    },
  },
  async ({ command, applicationId }) => {
    const appId = await getApplicationId(applicationId);
    const result = await rest.post(Routes.applicationCommands(appId), {
      body: command,
    });
    return jsonContent(result);
  },
);

server.registerTool(
  'upsert_guild_command',
  {
    title: 'Upsert guild command',
    description: 'Create or overwrite one guild-scoped command by name.',
    inputSchema: {
      guildId: z.string().min(1),
      command: commandSchema,
      applicationId: z.string().optional(),
    },
  },
  async ({ guildId, command, applicationId }) => {
    const appId = await getApplicationId(applicationId);
    const result = await rest.post(Routes.applicationGuildCommands(appId, guildId), {
      body: command,
    });
    return jsonContent(result);
  },
);

server.registerTool(
  'delete_global_command',
  {
    title: 'Delete global command',
    description: 'Delete one global application command by id.',
    inputSchema: {
      commandId: z.string().min(1),
      applicationId: z.string().optional(),
      confirm: z.literal(true),
    },
  },
  async ({ commandId, applicationId }) => {
    const appId = await getApplicationId(applicationId);
    await rest.delete(Routes.applicationCommand(appId, commandId));
    return jsonContent({ ok: true, deleted: commandId });
  },
);

server.registerTool(
  'delete_guild_command',
  {
    title: 'Delete guild command',
    description: 'Delete one guild-scoped application command by id.',
    inputSchema: {
      guildId: z.string().min(1),
      commandId: z.string().min(1),
      applicationId: z.string().optional(),
      confirm: z.literal(true),
    },
  },
  async ({ guildId, commandId, applicationId }) => {
    const appId = await getApplicationId(applicationId);
    await rest.delete(Routes.applicationGuildCommand(appId, guildId, commandId));
    return jsonContent({ ok: true, guildId, deleted: commandId });
  },
);

server.registerTool(
  'clear_guild_commands',
  {
    title: 'Clear guild commands',
    description: 'Replace all guild-scoped commands for one server with an empty list.',
    inputSchema: {
      guildId: z.string().min(1),
      applicationId: z.string().optional(),
      confirm: z.literal(true),
    },
  },
  async ({ guildId, applicationId }) => {
    const appId = await getApplicationId(applicationId);
    await rest.put(Routes.applicationGuildCommands(appId, guildId), {
      body: [],
    });
    return jsonContent({ ok: true, guildId, commands: [] });
  },
);

server.registerTool(
  'send_channel_message',
  {
    title: 'Send channel message',
    description: 'Send a plain text message as the bot. Mentions are disabled by default.',
    inputSchema: {
      channelId: z.string().min(1),
      content: z.string().min(1).max(2000),
    },
  },
  async ({ channelId, content }) => {
    const message = await rest.post(Routes.channelMessages(channelId), {
      body: {
        content,
        allowed_mentions: { parse: [] },
      },
    });
    return jsonContent(message);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

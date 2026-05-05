import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';
import { startYouTubeMonitor } from './youtubeMonitor.js';

const pingCommand = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Muel Bot is online.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[discord] online as ${readyClient.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  await rest.put(Routes.applicationCommands(readyClient.application.id), {
    body: [pingCommand.toJSON()],
  });
  console.log('[discord] registered /ping');

  startYouTubeMonitor(readyClient);
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

await client.login(config.discordBotToken);

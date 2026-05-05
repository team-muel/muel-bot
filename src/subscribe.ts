import { ChannelType, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import {
  createYouTubeSubscription,
  deleteYouTubeSubscription,
  listYouTubeSubscriptions,
  type YouTubeSubscription,
  type YouTubeSubscriptionKind,
} from './youtubeSubscriptionStore.js';

export const SUBSCRIBE_COMMAND_NAME = '\uad6c\ub3c5';
export const OPTION_ACTION = '\ub3d9\uc791';
export const OPTION_KIND = '\uc885\ub958';
export const OPTION_LINK = '\ub9c1\ud06c';
export const SUBSCRIBE_ACTION_LIST = 'list';
export const SUBSCRIBE_ACTION_ADD = 'add';
export const SUBSCRIBE_ACTION_REMOVE = 'remove';

const EMBED_INFO = 0x2f80ed;
const EMBED_WARN = 0xf2c94c;
const EMBED_ERROR = 0xeb5757;
const EMBED_SUCCESS = 0x27ae60;

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const buildSimpleEmbed = (title: string, description: string, color: number) => ({
  embeds: [
    new EmbedBuilder()
      .setTitle(title)
      .setDescription(description.slice(0, 4096))
      .setColor(color),
  ],
});

const getChannelTypeLabel = (channelType: number): string => {
  const mapped = ChannelType[channelType];
  return typeof mapped === 'string' ? mapped : String(channelType);
};

const toKindLabel = (kind: string): string => {
  if (kind === 'posts') return '\uac8c\uc2dc\uae00';
  if (kind === 'videos') return '\uc601\uc0c1';
  return kind;
};

const formatSubscriptionLine = (row: YouTubeSubscription): string => {
  const kind = row.url.endsWith('#posts')
    ? 'posts'
    : row.url.endsWith('#videos')
      ? 'videos'
      : 'unknown';
  const channelId = row.url.match(/\/channel\/(UC[0-9A-Za-z_-]{20,})/)?.[1] || 'unknown';
  const discordTarget = row.channel_id ? `<#${row.channel_id}>` : '-';
  return `#${row.id} [${toKindLabel(kind)}] youtube=${channelId} -> discord=${discordTarget}`;
};

const resolveRowChannelMeta = async (
  interaction: ChatInputCommandInteraction,
  row: YouTubeSubscription,
): Promise<string> => {
  if (!interaction.guild || !row.channel_id) return 'unknown';
  try {
    const channel = await interaction.guild.channels.fetch(row.channel_id);
    if (!channel) return 'missing';
    return `${channel.name} (${getChannelTypeLabel(channel.type)})`;
  } catch {
    return 'missing';
  }
};

const isValidSubscribeChannelType = (t: number): boolean =>
  t === ChannelType.GuildText ||
  t === ChannelType.GuildAnnouncement ||
  t === ChannelType.PublicThread ||
  t === ChannelType.PrivateThread ||
  t === ChannelType.AnnouncementThread;

const getKindOption = (interaction: ChatInputCommandInteraction): YouTubeSubscriptionKind | null => {
  const raw = interaction.options.getString(OPTION_KIND)?.trim();
  if (raw === 'posts' || raw === 'videos') {
    return raw;
  }
  return null;
};

const getChannelInput = (interaction: ChatInputCommandInteraction): string => {
  return (interaction.options.getString(OPTION_LINK) || '').trim();
};

export const handleSubscribeYouTubeCommand = async (
  interaction: ChatInputCommandInteraction,
  kind: YouTubeSubscriptionKind,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('Subscribe error', 'This command can only be used in a server.', EMBED_WARN), ephemeral: true });
    return;
  }

  const channelInput = getChannelInput(interaction);
  const targetChannel = interaction.channel;

  if (!channelInput) {
    await interaction.reply({ ...buildSimpleEmbed('Input error', 'Enter a YouTube channel URL or UC channel ID.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (!targetChannel || !isValidSubscribeChannelType(targetChannel.type)) {
    await interaction.reply({ ...buildSimpleEmbed('Channel error', 'Use this in a text, announcement, or thread channel.', EMBED_WARN), ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await createYouTubeSubscription({
      userId: interaction.user.id,
      guildId: interaction.guildId,
      discordChannelId: targetChannel.id,
      channelInput,
      kind,
    });
    const state = result.created ? 'Registered' : 'Already registered';
    await interaction.editReply(buildSimpleEmbed(
      'YouTube subscribe',
      `${state}: [${toKindLabel(kind)}] youtube=${result.channelId} -> discord=<#${targetChannel.id}> (${getChannelTypeLabel(targetChannel.type)})`,
      result.created ? EMBED_SUCCESS : EMBED_INFO,
    ));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('Subscribe failed', getErrorMessage(error), EMBED_ERROR));
  }
};

export const handleSubscriptionListCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('Subscriptions', 'This command can only be used in a server.', EMBED_WARN), ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const rows = await listYouTubeSubscriptions({ guildId: interaction.guildId });
    if (rows.length === 0) {
      await interaction.editReply(buildSimpleEmbed('Subscriptions', 'No YouTube subscriptions are registered.', EMBED_INFO));
      return;
    }

    const previewRows = rows.slice(0, 20);
    const lines = await Promise.all(previewRows.map(async (row) => {
      const line = formatSubscriptionLine(row);
      const meta = await resolveRowChannelMeta(interaction, row);
      return `${line} | channel=${meta}`;
    }));
    const suffix = rows.length > 20 ? `\n...(${rows.length - 20} more)` : '';

    await interaction.editReply(buildSimpleEmbed('Subscriptions', [...lines, suffix].filter(Boolean).join('\n'), EMBED_INFO));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('List failed', getErrorMessage(error), EMBED_ERROR));
  }
};

export const handleUnsubscribeCommand = async (
  interaction: ChatInputCommandInteraction,
  forcedKind?: YouTubeSubscriptionKind,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('Unsubscribe', 'This command can only be used in a server.', EMBED_WARN), ephemeral: true });
    return;
  }

  const kind = forcedKind ?? getKindOption(interaction);
  const channelInput = getChannelInput(interaction);
  const targetChannel = interaction.channel;

  if (!kind) {
    await interaction.reply({ ...buildSimpleEmbed('Input error', 'Choose videos or posts.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (!channelInput) {
    await interaction.reply({ ...buildSimpleEmbed('Input error', 'Enter the YouTube channel to remove.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (!targetChannel || !isValidSubscribeChannelType(targetChannel.type)) {
    await interaction.reply({ ...buildSimpleEmbed('Channel error', 'Use this in a text, announcement, or thread channel.', EMBED_WARN), ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await deleteYouTubeSubscription({
      guildId: interaction.guildId,
      discordChannelId: targetChannel.id,
      channelInput,
      kind,
    });

    await interaction.editReply(buildSimpleEmbed(
      result.deleted ? 'Unsubscribed' : 'No subscription found',
      result.deleted
        ? `Removed: [${toKindLabel(kind)}] youtube=${result.channelId} -> discord=<#${targetChannel.id}>`
        : `Nothing to remove: [${toKindLabel(kind)}] youtube=${result.channelId} -> discord=<#${targetChannel.id}>`,
      result.deleted ? EMBED_SUCCESS : EMBED_WARN,
    ));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('Unsubscribe failed', getErrorMessage(error), EMBED_ERROR));
  }
};

export const handleGroupedSubscribeCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  const subcommand = interaction.options.getSubcommand(false);

  if (subcommand === 'list') {
    await handleSubscriptionListCommand(interaction);
    return;
  }

  if (subcommand === 'add') {
    const kind = getKindOption(interaction);
    if (!kind) {
      await interaction.reply({ ...buildSimpleEmbed('Input error', 'Choose videos or posts.', EMBED_WARN), ephemeral: true });
      return;
    }
    await handleSubscribeYouTubeCommand(interaction, kind);
    return;
  }

  if (subcommand === 'remove') {
    await handleUnsubscribeCommand(interaction);
    return;
  }

  await handleSubscriptionListCommand(interaction);
};

export const handleFlatSubscribeCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  const action = interaction.options.getString(OPTION_ACTION)?.trim();

  if (action === SUBSCRIBE_ACTION_LIST) {
    await handleSubscriptionListCommand(interaction);
    return;
  }

  const kind = getKindOption(interaction);
  if (!kind) {
    await interaction.reply({ ...buildSimpleEmbed('Input error', '영상 또는 게시글을 선택해주세요.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (action === SUBSCRIBE_ACTION_ADD) {
    await handleSubscribeYouTubeCommand(interaction, kind);
    return;
  }

  if (action === SUBSCRIBE_ACTION_REMOVE) {
    await handleUnsubscribeCommand(interaction, kind);
    return;
  }

  await interaction.reply({ ...buildSimpleEmbed('Input error', '조회, 추가, 제거 중 하나를 선택해주세요.', EMBED_WARN), ephemeral: true });
};

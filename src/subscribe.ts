import { ChannelType, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import {
  createYouTubeSubscription,
  deleteYouTubeSubscription,
  listYouTubeSubscriptions,
  type YouTubeSubscription,
  type YouTubeSubscriptionKind,
} from './youtubeSubscriptionStore.js';

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
  if (kind === 'posts') return '게시글';
  if (kind === 'videos') return '영상';
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
  const raw = interaction.options.getString('종류')?.trim();
  if (raw === 'posts' || raw === 'videos') {
    return raw;
  }
  return null;
};

const getChannelInput = (interaction: ChatInputCommandInteraction): string => {
  return (interaction.options.getString('링크') || interaction.options.getString('유튜브채널') || '').trim();
};

export const handleSubscribeYouTubeCommand = async (
  interaction: ChatInputCommandInteraction,
  kind: YouTubeSubscriptionKind,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('구독 오류', '서버 안에서만 사용할 수 있습니다.', EMBED_WARN), ephemeral: true });
    return;
  }

  const channelInput = getChannelInput(interaction);
  const targetChannel = interaction.channel;

  if (!channelInput) {
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', 'YouTube 채널 링크를 입력해주세요.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (!targetChannel || !isValidSubscribeChannelType(targetChannel.type)) {
    await interaction.reply({ ...buildSimpleEmbed('채널 오류', '텍스트/공지/스레드 채널만 구독 대상으로 지정할 수 있습니다.', EMBED_WARN), ephemeral: true });
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
    const state = result.created ? '등록 완료' : '이미 등록됨';
    await interaction.editReply(buildSimpleEmbed(
      'YouTube 구독',
      `${state}: [${toKindLabel(kind)}] youtube=${result.channelId} -> discord=<#${targetChannel.id}> (${getChannelTypeLabel(targetChannel.type)})`,
      result.created ? EMBED_SUCCESS : EMBED_INFO,
    ));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('구독 실패', getErrorMessage(error), EMBED_ERROR));
  }
};

export const handleSubscriptionListCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('구독 목록', '서버 안에서만 사용할 수 있습니다.', EMBED_WARN), ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const rows = await listYouTubeSubscriptions({ guildId: interaction.guildId });
    if (rows.length === 0) {
      await interaction.editReply(buildSimpleEmbed('구독 목록', '등록된 YouTube 구독이 없습니다.', EMBED_INFO));
      return;
    }

    const previewRows = rows.slice(0, 20);
    const lines = await Promise.all(previewRows.map(async (row) => {
      const line = formatSubscriptionLine(row);
      const meta = await resolveRowChannelMeta(interaction, row);
      return `${line} | channel=${meta}`;
    }));
    const suffix = rows.length > 20 ? `\n...(${rows.length - 20} more)` : '';

    await interaction.editReply(buildSimpleEmbed('구독 목록', [...lines, suffix].filter(Boolean).join('\n'), EMBED_INFO));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('목록 조회 실패', getErrorMessage(error), EMBED_ERROR));
  }
};

export const handleUnsubscribeCommand = async (
  interaction: ChatInputCommandInteraction,
  forcedKind?: YouTubeSubscriptionKind,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('구독 해제', '서버 안에서만 사용할 수 있습니다.', EMBED_WARN), ephemeral: true });
    return;
  }

  const kind = forcedKind ?? getKindOption(interaction);
  const channelInput = getChannelInput(interaction);
  const targetChannel = interaction.channel;

  if (!kind) {
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', '종류는 영상 또는 게시글 중 하나여야 합니다.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (!channelInput) {
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', '해제할 YouTube 채널 링크를 입력해주세요.', EMBED_WARN), ephemeral: true });
    return;
  }

  if (!targetChannel || !isValidSubscribeChannelType(targetChannel.type)) {
    await interaction.reply({ ...buildSimpleEmbed('채널 오류', '텍스트/공지/스레드 채널만 해제 대상으로 지정할 수 있습니다.', EMBED_WARN), ephemeral: true });
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
      result.deleted ? '구독 해제 완료' : '구독 없음',
      result.deleted
        ? `해제 완료: [${toKindLabel(kind)}] youtube=${result.channelId} -> discord=<#${targetChannel.id}>`
        : `해제 대상이 없습니다: [${toKindLabel(kind)}] youtube=${result.channelId} -> discord=<#${targetChannel.id}>`,
      result.deleted ? EMBED_SUCCESS : EMBED_WARN,
    ));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('해제 실패', getErrorMessage(error), EMBED_ERROR));
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
      await interaction.reply({ ...buildSimpleEmbed('입력 오류', '종류는 영상 또는 게시글 중 하나여야 합니다.', EMBED_WARN), ephemeral: true });
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

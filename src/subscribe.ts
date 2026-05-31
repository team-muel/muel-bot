import { ChannelType, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import {
  createYouTubeSubscription,
  deleteYouTubeSubscription,
  listYouTubeSubscriptions,
  type YouTubeSubscriptionKind,
} from './youtubeSubscriptionStore.js';
import {
  formatDiscordTarget,
  formatSubscriptionLine,
  formatYouTubeTarget,
  toKindLabel,
} from './subscribePresentation.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import type { RenderTone } from './rendering/types.js';

export const SUBSCRIBE_COMMAND_NAME = '\uad6c\ub3c5';
export const OPTION_ACTION = '\ub3d9\uc791';
export const OPTION_KIND = '\uc885\ub958';
export const OPTION_LINK = '\ub9c1\ud06c';
export const SUBSCRIBE_ACTION_LIST = 'list';
export const SUBSCRIBE_ACTION_ADD = 'add';
export const SUBSCRIBE_ACTION_REMOVE = 'remove';

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const buildSimpleEmbed = (title: string, description: string, tone: RenderTone = 'muel') =>
  renderDiscordMessage([{
    type: 'info-card',
    tone,
    title,
    body: description,
  }]) as any;

const resolveRowChannelMeta = async (
  interaction: ChatInputCommandInteraction,
  row: Parameters<typeof formatSubscriptionLine>[0],
): Promise<string> => {
  if (!interaction.guild || !row.channel_id) return formatSubscriptionLine(row, null);
  try {
    const channel = await interaction.guild.channels.fetch(row.channel_id);
    if (!channel) return formatSubscriptionLine(row, null);
    return formatSubscriptionLine(row, { id: channel.id, name: channel.name, type: channel.type });
  } catch {
    return formatSubscriptionLine(row, null);
  }
};

const isValidSubscribeChannelType = (t: number): boolean =>
  t === ChannelType.GuildText ||
  t === ChannelType.GuildAnnouncement ||
  t === ChannelType.PublicThread ||
  t === ChannelType.PrivateThread ||
  t === ChannelType.AnnouncementThread;

const getChannelName = (channel: unknown): string | null => {
  if (!channel || typeof channel !== 'object' || !('name' in channel)) return null;
  const name = (channel as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
};

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
    await interaction.reply({ ...buildSimpleEmbed('구독 오류', '이 명령어는 서버에서만 사용할 수 있어요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const channelInput = getChannelInput(interaction);
  const targetChannel = interaction.channel;

  if (!channelInput) {
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', 'YouTube 채널 URL 또는 UC 채널 ID를 입력해주세요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (!targetChannel || !isValidSubscribeChannelType(targetChannel.type)) {
    await interaction.reply({ ...buildSimpleEmbed('채널 오류', '텍스트, 공지, 스레드 채널에서만 사용할 수 있어요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const result = await createYouTubeSubscription({
      userId: interaction.user.id,
      guildId: interaction.guildId,
      discordChannelId: targetChannel.id,
      channelInput,
      kind,
    });
    const state = result.created ? '등록했어' : '이미 등록되어 있어';
    await interaction.editReply(buildSimpleEmbed(
      'YouTube 구독',
      `${state}: [${toKindLabel(kind)}] ${formatYouTubeTarget(result.row)} -> ${formatDiscordTarget({ id: targetChannel.id, name: getChannelName(targetChannel), type: targetChannel.type })}`,
      result.created ? 'success' : 'muel',
    ));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('구독 실패', getErrorMessage(error), 'warning'));
  }
};

export const handleSubscriptionListCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('구독 목록', '이 명령어는 서버에서만 사용할 수 있어요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const rows = await listYouTubeSubscriptions({ guildId: interaction.guildId });
    if (rows.length === 0) {
      await interaction.editReply(buildSimpleEmbed('구독 목록', '등록된 YouTube 구독이 없어요.', 'muel'));
      return;
    }

    const previewRows = rows.slice(0, 20);
    const lines = await Promise.all(previewRows.map((row) => resolveRowChannelMeta(interaction, row)));
    const suffix = rows.length > 20 ? `\n...(${rows.length - 20}개 더 있음)` : '';

    await interaction.editReply(buildSimpleEmbed('구독 목록', [...lines, suffix].filter(Boolean).join('\n'), 'muel'));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('목록 조회 실패', getErrorMessage(error), 'warning'));
  }
};

export const handleUnsubscribeCommand = async (
  interaction: ChatInputCommandInteraction,
  forcedKind?: YouTubeSubscriptionKind,
): Promise<void> => {
  if (!interaction.guildId) {
    await interaction.reply({ ...buildSimpleEmbed('구독 제거', '이 명령어는 서버에서만 사용할 수 있어요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const kind = forcedKind ?? getKindOption(interaction);
  const channelInput = getChannelInput(interaction);
  const targetChannel = interaction.channel;

  if (!kind) {
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', '영상 또는 게시글을 선택해주세요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (!channelInput) {
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', '제거할 YouTube 채널을 입력해주세요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (!targetChannel || !isValidSubscribeChannelType(targetChannel.type)) {
    await interaction.reply({ ...buildSimpleEmbed('채널 오류', '텍스트, 공지, 스레드 채널에서만 사용할 수 있어요.', 'warning'), flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const result = await deleteYouTubeSubscription({
      guildId: interaction.guildId,
      discordChannelId: targetChannel.id,
      channelInput,
      kind,
    });

    await interaction.editReply(buildSimpleEmbed(
      result.deleted ? '구독 제거 완료' : '구독을 찾지 못했어요',
      result.deleted
        ? `제거했어: [${toKindLabel(kind)}] ${formatYouTubeTarget(result.channelId)} -> ${formatDiscordTarget({ id: targetChannel.id, name: getChannelName(targetChannel), type: targetChannel.type })}`
        : `제거할 항목이 없어: [${toKindLabel(kind)}] ${formatYouTubeTarget(result.channelId)} -> ${formatDiscordTarget({ id: targetChannel.id, name: getChannelName(targetChannel), type: targetChannel.type })}`,
      result.deleted ? 'success' : 'warning',
    ));
  } catch (error) {
    await interaction.editReply(buildSimpleEmbed('구독 제거 실패', getErrorMessage(error), 'warning'));
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
      await interaction.reply({ ...buildSimpleEmbed('입력 오류', '영상 또는 게시글을 선택해주세요.', 'warning'), flags: [MessageFlags.Ephemeral] });
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
    await interaction.reply({ ...buildSimpleEmbed('입력 오류', '영상 또는 게시글을 선택해주세요.', 'warning'), flags: [MessageFlags.Ephemeral] });
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

  await interaction.reply({ ...buildSimpleEmbed('입력 오류', '조회, 추가, 제거 중 하나를 선택해주세요.', 'warning'), flags: [MessageFlags.Ephemeral] });
};

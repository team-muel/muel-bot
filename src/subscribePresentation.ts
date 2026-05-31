import { ChannelType } from 'discord.js';
import type { YouTubeSubscription, YouTubeSubscriptionKind } from './youtubeSubscriptionStore.js';

type DiscordTarget = {
  id?: string | null;
  name?: string | null;
  type?: number | null;
};

const CHANNEL_ID_RE = /\/channel\/(UC[0-9A-Za-z_-]{20,})/;

export const getSubscriptionKind = (row: YouTubeSubscription): YouTubeSubscriptionKind | 'unknown' => {
  if (row.url.endsWith('#posts') || row.name?.toLowerCase().includes('posts')) return 'posts';
  if (row.url.endsWith('#videos') || row.name?.toLowerCase().includes('videos')) return 'videos';
  return 'unknown';
};

export const toKindLabel = (kind: string): string => {
  if (kind === 'posts') return '게시글';
  if (kind === 'videos') return '영상';
  return '구독';
};

export const getChannelTypeLabel = (channelType?: number | null): string => {
  switch (channelType) {
    case ChannelType.GuildText:
      return '텍스트 채널';
    case ChannelType.GuildAnnouncement:
      return '공지 채널';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return '스레드';
    default:
      return 'Discord 채널';
  }
};

export const extractSubscribedYouTubeChannelId = (url: string): string | null =>
  url.match(CHANNEL_ID_RE)?.[1] ?? null;

const maskYouTubeChannelId = (channelId: string | null): string | null => {
  if (!channelId) return null;
  return `ID 끝자리 ${channelId.slice(-6)}`;
};

export const getStoredYouTubeChannelTitle = (row: YouTubeSubscription): string | null => {
  const name = row.name?.trim();
  if (!name?.toLowerCase().startsWith('youtube-')) return null;
  const separator = name.indexOf(':');
  if (separator === -1) return null;
  const title = name.slice(separator + 1).trim();
  return title || null;
};

export const formatYouTubeTarget = (rowOrChannelId: YouTubeSubscription | string | null | undefined): string => {
  if (!rowOrChannelId) return 'YouTube 채널';

  if (typeof rowOrChannelId === 'string') {
    const masked = maskYouTubeChannelId(rowOrChannelId);
    return `YouTube 채널${masked ? ` (${masked})` : ''}`;
  }

  const title = getStoredYouTubeChannelTitle(rowOrChannelId);
  if (title) return title;

  const channelId = extractSubscribedYouTubeChannelId(rowOrChannelId.url);
  const masked = maskYouTubeChannelId(channelId);
  return masked ? `YouTube 채널 (${masked})` : 'YouTube 채널';
};

export const formatDiscordTarget = (target: DiscordTarget | null | undefined): string => {
  if (!target?.id && !target?.name) return 'Discord 채널 미지정';
  const label = target.name?.trim()
    ? `#${target.name.trim()}`
    : target.id
      ? `<#${target.id}>`
      : 'Discord 채널';
  return `${label} (${getChannelTypeLabel(target.type)})`;
};

export const formatMissingDiscordTarget = (): string => '삭제됐거나 접근할 수 없는 Discord 채널';

export const formatSubscriptionLine = (
  row: YouTubeSubscription,
  target?: DiscordTarget | null,
): string => {
  const kind = getSubscriptionKind(row);
  const youtubeTarget = formatYouTubeTarget(row);
  const discordTarget = target === null
    ? formatMissingDiscordTarget()
    : target
    ? formatDiscordTarget(target)
    : row.channel_id
      ? 'Discord 채널 확인 필요'
      : 'Discord 채널 미지정';
  return `[${toKindLabel(kind)}] ${youtubeTarget} -> ${discordTarget}`;
};

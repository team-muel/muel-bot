import { config } from './config.js';
import { fetchWithTimeout } from './utils/network.js';

export type YouTubeVideoMetadata = {
  videoId: string;
  title: string | null;
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  publishedAt: string | null;
  tags: string[];
  categoryId: string | null;
  duration: string | null;
  viewCount: string | null;
  likeCount: string | null;
  commentCount: string | null;
  topicCategories: string[];
  liveBroadcastContent: 'none' | 'live' | 'upcoming' | null;
  madeForKids: boolean | null;
  containsSyntheticMedia: boolean | null;
  hasPaidProductPlacement: boolean | null;
  brandPartnerChannelId: string | null;
};

export type YouTubeChannelMetadata = {
  channelId: string;
  title: string | null;
  description: string | null;
  customUrl: string | null;
  uploadsPlaylistId: string | null;
  subscriberCount: string | null;
  viewCount: string | null;
  videoCount: string | null;
};

export type YouTubeVideoStat = {
  videoId: string;
  publishedAt: string | null;
  duration: string | null;
  durationMillis: string | null;
  viewCount: string | null;
  likeCount: string | null;
  commentCount: string | null;
};

export type YouTubeUploadPlaylistItem = {
  videoId: string;
  title: string;
  description: string;
  channelId: string | null;
  channelTitle: string | null;
  publishedAt: string | null;
};

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

type VideoListResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      channelId?: string;
      channelTitle?: string;
      publishedAt?: string;
      tags?: string[];
      categoryId?: string;
      liveBroadcastContent?: 'none' | 'live' | 'upcoming';
    };
    contentDetails?: {
      duration?: string;
    };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
    topicDetails?: {
      topicCategories?: string[];
    };
    status?: {
      madeForKids?: boolean;
      containsSyntheticMedia?: boolean;
    };
    paidProductPlacementDetails?: {
      hasPaidProductPlacement?: boolean;
    };
    brandPartner?: {
      channelId?: string;
    };
  }>;
};

type ChannelListResponse = {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      customUrl?: string;
    };
    contentDetails?: {
      relatedPlaylists?: {
        uploads?: string;
      };
    };
    statistics?: {
      subscriberCount?: string;
      viewCount?: string;
      videoCount?: string;
    };
  }>;
};

type VideoStatsResponse = {
  items?: Array<{
    id?: string;
    snippet?: { publishTime?: string };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
    contentDetails?: {
      duration?: string;
      durationMillis?: string;
    };
  }>;
};

type PlaylistItemsResponse = {
  items?: Array<{
    snippet?: {
      title?: string;
      description?: string;
      channelId?: string;
      channelTitle?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
    };
    contentDetails?: {
      videoId?: string;
      videoPublishedAt?: string;
    };
  }>;
};

const parseApiError = async (response: Response, path: string): Promise<YouTubeApiError> => {
  const text = (await response.text()).slice(0, 2_000);
  let reason: string | null = null;
  let message = text || response.statusText || 'request failed';
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string;
        errors?: Array<{ reason?: string }>;
      };
    };
    reason = parsed.error?.errors?.[0]?.reason ?? null;
    message = parsed.error?.message ?? message;
  } catch {
    // Preserve the bounded response text for non-JSON gateway errors.
  }
  return new YouTubeApiError(
    `YouTube Data API ${path} failed: ${response.status} ${reason ? `${reason}: ` : ''}${message}`,
    response.status,
    reason,
    response.status === 429 || response.status >= 500,
  );
};

async function getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
  if (!config.youtubeDataApiKey) return null;

  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('key', config.youtubeDataApiKey);

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        accept: 'application/json',
        'user-agent': 'MuelBot/1.0',
      },
    },
    Math.min(config.youtubeFetchTimeoutMs, 12_000),
  );

  if (!response.ok) {
    throw await parseApiError(response, path);
  }

  return (await response.json()) as T;
}

const mapVideoMetadata = (
  item: NonNullable<VideoListResponse['items']>[number],
): YouTubeVideoMetadata | null => {
  if (!item.id) return null;
  return {
    videoId: item.id,
    title: item.snippet?.title ?? null,
    description: item.snippet?.description ?? null,
    channelId: item.snippet?.channelId ?? null,
    channelTitle: item.snippet?.channelTitle ?? null,
    publishedAt: item.snippet?.publishedAt ?? null,
    tags: item.snippet?.tags ?? [],
    categoryId: item.snippet?.categoryId ?? null,
    duration: item.contentDetails?.duration ?? null,
    viewCount: item.statistics?.viewCount ?? null,
    likeCount: item.statistics?.likeCount ?? null,
    commentCount: item.statistics?.commentCount ?? null,
    topicCategories: item.topicDetails?.topicCategories ?? [],
    liveBroadcastContent: item.snippet?.liveBroadcastContent ?? null,
    madeForKids: item.status?.madeForKids ?? null,
    containsSyntheticMedia: item.status?.containsSyntheticMedia ?? null,
    hasPaidProductPlacement:
      item.paidProductPlacementDetails?.hasPaidProductPlacement ?? null,
    brandPartnerChannelId: item.brandPartner?.channelId ?? null,
  };
};

export async function fetchYouTubeVideosMetadata(
  videoIds: string[],
): Promise<YouTubeVideoMetadata[]> {
  const ids = [...new Set(videoIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (ids.length === 0) return [];
  const data = await getJson<VideoListResponse>('videos', {
    part: [
      'snippet',
      'contentDetails',
      'statistics',
      'topicDetails',
      'status',
      'paidProductPlacementDetails',
      'brandPartner',
    ].join(','),
    id: ids.join(','),
    fields: [
      'items(id',
      'snippet(title,description,channelId,channelTitle,publishedAt,tags,categoryId,liveBroadcastContent)',
      'contentDetails(duration)',
      'statistics(viewCount,likeCount,commentCount)',
      'topicDetails/topicCategories',
      'status(madeForKids,containsSyntheticMedia)',
      'paidProductPlacementDetails/hasPaidProductPlacement',
      'brandPartner/channelId)',
    ].join(','),
  });
  return (data?.items ?? [])
    .map(mapVideoMetadata)
    .filter((item): item is YouTubeVideoMetadata => Boolean(item));
}

export async function fetchYouTubeVideoMetadata(
  videoId: string,
): Promise<YouTubeVideoMetadata | null> {
  return (await fetchYouTubeVideosMetadata([videoId]))[0] ?? null;
}

const fetchChannelMetadata = async (
  filter: { id: string } | { forHandle: string },
): Promise<YouTubeChannelMetadata | null> => {
  const data = await getJson<ChannelListResponse>('channels', {
    part: 'snippet,contentDetails,statistics',
    ...filter,
    fields: [
      'items(id',
      'snippet(title,description,customUrl)',
      'contentDetails/relatedPlaylists/uploads',
      'statistics(subscriberCount,viewCount,videoCount))',
    ].join(','),
  });
  const item = data?.items?.[0];
  if (!item?.id) return null;

  return {
    channelId: item.id,
    title: item.snippet?.title ?? null,
    description: item.snippet?.description ?? null,
    customUrl: item.snippet?.customUrl ?? null,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    subscriberCount: item.statistics?.subscriberCount ?? null,
    viewCount: item.statistics?.viewCount ?? null,
    videoCount: item.statistics?.videoCount ?? null,
  };
};

export async function fetchYouTubeChannelMetadata(
  channelId: string,
): Promise<YouTubeChannelMetadata | null> {
  return fetchChannelMetadata({ id: channelId });
}

export async function fetchYouTubeChannelMetadataByHandle(
  handle: string,
): Promise<YouTubeChannelMetadata | null> {
  const normalized = handle.trim().replace(/^@/, '');
  if (!normalized) return null;
  return fetchChannelMetadata({ forHandle: normalized });
}

export async function fetchYouTubeVideoStats(
  videoIds: string[],
): Promise<YouTubeVideoStat[]> {
  const ids = [...new Set(videoIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (ids.length === 0) return [];
  const data = await getJson<VideoStatsResponse>('videos:batchGetStats', {
    part: 'snippet,contentDetails,statistics',
    id: ids.join(','),
    fields: [
      'items(id',
      'snippet/publishTime',
      'contentDetails(duration,durationMillis)',
      'statistics(viewCount,likeCount,commentCount))',
    ].join(','),
  });
  return (data?.items ?? []).flatMap((item) => item.id ? [{
    videoId: item.id,
    publishedAt: item.snippet?.publishTime ?? null,
    duration: item.contentDetails?.duration ?? null,
    durationMillis: item.contentDetails?.durationMillis ?? null,
    viewCount: item.statistics?.viewCount ?? null,
    likeCount: item.statistics?.likeCount ?? null,
    commentCount: item.statistics?.commentCount ?? null,
  }] : []);
}

export async function fetchYouTubeUploadsPlaylistItems(
  playlistId: string,
  maxResults = 50,
): Promise<YouTubeUploadPlaylistItem[]> {
  const data = await getJson<PlaylistItemsResponse>('playlistItems', {
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: String(Math.max(1, Math.min(50, maxResults))),
    fields: [
      'items(',
      'snippet(title,description,channelId,channelTitle,publishedAt,resourceId/videoId),',
      'contentDetails(videoId,videoPublishedAt))',
    ].join(''),
  });
  return (data?.items ?? []).flatMap((item) => {
    const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
    if (!videoId) return [];
    return [{
      videoId,
      title: item.snippet?.title ?? 'YouTube video',
      description: item.snippet?.description ?? '',
      channelId: item.snippet?.channelId ?? null,
      channelTitle: item.snippet?.channelTitle ?? null,
      publishedAt:
        item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? null,
    }];
  });
}

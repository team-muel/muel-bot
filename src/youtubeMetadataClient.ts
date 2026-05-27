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
    throw new Error(`YouTube Data API ${path} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

export async function fetchYouTubeVideoMetadata(videoId: string): Promise<YouTubeVideoMetadata | null> {
  const data = await getJson<VideoListResponse>('videos', {
    part: 'snippet,contentDetails,statistics,topicDetails',
    id: videoId,
  });
  const item = data?.items?.[0];
  if (!item?.id) return null;

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
  };
}

export async function fetchYouTubeChannelMetadata(channelId: string): Promise<YouTubeChannelMetadata | null> {
  const data = await getJson<ChannelListResponse>('channels', {
    part: 'snippet,contentDetails,statistics',
    id: channelId,
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
}

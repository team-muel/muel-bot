import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';
import {
  fetchYouTubeVideosMetadata,
  fetchYouTubeVideoStats,
} from './youtubeMetadataClient.js';

const API_REFRESH_AGE_MS = 29 * 24 * 60 * 60_000;
const STATS_REFRESH_AGE_MS = 24 * 60 * 60_000;
const RECENT_STATS_WINDOW_MS = 30 * 24 * 60 * 60_000;
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 4;

type LifecycleRow = {
  id: string;
  youtube_id: string;
  metadata: Record<string, unknown> | null;
  statistics: Record<string, string | null> | null;
};

export type YouTubeLifecycleResult = {
  metadataRefreshed: number;
  deleted: number;
  statsRefreshed: number;
};

const refreshStaleMetadata = async (): Promise<{ refreshed: number; deleted: number }> => {
  const db = getSupabaseClient();
  const cutoff = new Date(Date.now() - API_REFRESH_AGE_MS).toISOString();
  let refreshed = 0;
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const { data, error } = await db
      .from('muel_youtube_items')
      .select('id,youtube_id,metadata,statistics')
      .in('kind', ['video', 'shorts'])
      .or(`api_refreshed_at.is.null,api_refreshed_at.lt.${cutoff}`)
      .order('api_refreshed_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);
    if (error) throw error;
    const rows = (data ?? []) as LifecycleRow[];
    if (rows.length === 0) break;

    const metadata = await fetchYouTubeVideosMetadata(rows.map((row) => row.youtube_id));
    const byId = new Map(metadata.map((item) => [item.videoId, item]));
    const refreshedAt = new Date().toISOString();
    for (const row of rows) {
      const item = byId.get(row.youtube_id);
      if (!item) {
        const { error: deleteError } = await db
          .from('muel_youtube_items')
          .delete()
          .eq('id', row.id);
        if (deleteError) throw deleteError;
        deleted += 1;
        continue;
      }

      const { error: updateError } = await db
        .from('muel_youtube_items')
        .update({
          channel_id: item.channelId,
          channel_title: item.channelTitle,
          title: item.title,
          description: item.description,
          published_at: item.publishedAt,
          tags: item.tags,
          category_id: item.categoryId,
          duration: item.duration,
          statistics: {
            viewCount: item.viewCount,
            likeCount: item.likeCount,
            commentCount: item.commentCount,
          },
          topic_categories: item.topicCategories,
          metadata: {
            ...(row.metadata ?? {}),
            source: 'youtube_data_api_refresh',
            youtube: item,
          },
          api_refreshed_at: refreshedAt,
          stats_refreshed_at: refreshedAt,
        })
        .eq('id', row.id);
      if (updateError) throw updateError;
      refreshed += 1;
    }
  }
  return { refreshed, deleted };
};

const refreshRecentStatistics = async (): Promise<number> => {
  const db = getSupabaseClient();
  const staleBefore = new Date(Date.now() - STATS_REFRESH_AGE_MS).toISOString();
  const recentAfter = new Date(Date.now() - RECENT_STATS_WINDOW_MS).toISOString();
  let refreshed = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const { data, error } = await db
      .from('muel_youtube_items')
      .select('id,youtube_id,metadata,statistics')
      .in('kind', ['video', 'shorts'])
      .gte('published_at', recentAfter)
      .or(`stats_refreshed_at.is.null,stats_refreshed_at.lt.${staleBefore}`)
      .order('stats_refreshed_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);
    if (error) throw error;
    const rows = (data ?? []) as LifecycleRow[];
    if (rows.length === 0) break;

    const stats = await fetchYouTubeVideoStats(rows.map((row) => row.youtube_id));
    const byId = new Map(stats.map((item) => [item.videoId, item]));
    const refreshedAt = new Date().toISOString();
    for (const row of rows) {
      const item = byId.get(row.youtube_id);
      if (!item) continue;
      const { error: updateError } = await db
        .from('muel_youtube_items')
        .update({
          duration: item.duration,
          statistics: {
            ...(row.statistics ?? {}),
            viewCount: item.viewCount,
            likeCount: item.likeCount,
            commentCount: item.commentCount,
          },
          metadata: {
            ...(row.metadata ?? {}),
            statsDurationMillis: item.durationMillis,
          },
          stats_refreshed_at: refreshedAt,
        })
        .eq('id', row.id);
      if (updateError) throw updateError;
      refreshed += 1;
    }
  }
  return refreshed;
};

export const runYouTubeApiDataLifecycle = async (): Promise<YouTubeLifecycleResult> => {
  if (!config.youtubeDataApiKey) {
    return { metadataRefreshed: 0, deleted: 0, statsRefreshed: 0 };
  }
  const metadata = await refreshStaleMetadata();
  const statsRefreshed = await refreshRecentStatistics();
  return {
    metadataRefreshed: metadata.refreshed,
    deleted: metadata.deleted,
    statsRefreshed,
  };
};

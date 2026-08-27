import type { SupabaseClient } from '@supabase/supabase-js';
import type { YouTubeChannelMetadata, YouTubeVideoMetadata } from './youtubeMetadataClient.js';

export type YouTubeItemKind = 'video' | 'shorts' | 'community_post';

export const YOUTUBE_PUBLIC_VIEW_COUNT_EFFECTIVE_AT = '2026-08-24T00:00:00.000Z';
export const YOUTUBE_PUBLIC_VIEW_COUNT_SEMANTICS = 'public_play_starts_v2';

export type YouTubeItemUpsert = {
  sourceId?: number | null;
  kind: YouTubeItemKind;
  youtubeId: string;
  channelId?: string | null;
  channelTitle?: string | null;
  title?: string | null;
  description?: string | null;
  url: string;
  publishedAt?: string | null;
  isShorts?: boolean | null;
  tags?: string[];
  categoryId?: string | null;
  duration?: string | null;
  statistics?: Record<string, string | null>;
  topicCategories?: string[];
  raw?: Record<string, unknown>;
  apiRefreshedAt?: string | null;
  statsRefreshedAt?: string | null;
};

export type StoredYouTubeItem = {
  id: string;
  kind: YouTubeItemKind;
  youtube_id: string;
  channel_id: string | null;
  channel_title: string | null;
  title: string | null;
  description: string | null;
  url: string;
  published_at: string | null;
  is_shorts: boolean | null;
  tags: string[] | null;
  category_id: string | null;
  duration: string | null;
  statistics: Record<string, string | null> | null;
  topic_categories: string[] | null;
  metadata: Record<string, unknown> | null;
  api_refreshed_at: string | null;
  stats_refreshed_at: string | null;
  created_at: string;
};

const truncate = (value: string | null | undefined, max: number): string | null => {
  if (!value) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
};

const formatPublicViewCount = (
  statistics: Record<string, string | null> | null,
  metadata: Record<string, unknown> | null,
): string => {
  if (!statistics?.viewCount) return '';
  const semantics = metadata?.viewCountSemantics;
  return semantics === YOUTUBE_PUBLIC_VIEW_COUNT_SEMANTICS
    ? ` · 공개 조회수 ${statistics.viewCount} (2026-08-24 이후 재생 시작 기준)`
    : ` · 공개 조회수 ${statistics.viewCount} (집계 기준 미표기·시계열 비교 금지)`;
};

const toIsoDateOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export async function upsertYouTubeItem(
  supabase: SupabaseClient,
  input: YouTubeItemUpsert,
): Promise<void> {
  const { error } = await supabase
    .from('muel_youtube_items')
    .upsert(
      {
        source_id: input.sourceId ?? null,
        kind: input.kind,
        youtube_id: input.youtubeId,
        channel_id: input.channelId ?? null,
        channel_title: input.channelTitle ?? null,
        title: input.title ?? null,
        description: input.description ?? null,
        url: input.url,
        published_at: toIsoDateOrNull(input.publishedAt),
        is_shorts: input.isShorts ?? null,
        tags: input.tags ?? [],
        category_id: input.categoryId ?? null,
        duration: input.duration ?? null,
        statistics: input.statistics ?? {},
        topic_categories: input.topicCategories ?? [],
        metadata: input.raw ?? {},
        api_refreshed_at: input.apiRefreshedAt ?? null,
        stats_refreshed_at: input.statsRefreshedAt ?? input.apiRefreshedAt ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'kind,youtube_id' },
    );

  if (error) {
    console.warn('[youtube] failed to upsert item cache', error);
  }
}

/**
 * Atomically claim a YouTube/community item for delivery, keyed per source.
 *
 * Returns true only for the caller that actually inserted the ledger row (first
 * delivery); false if the item was already claimed/delivered. This is the
 * idempotency gate that makes duplicate posts impossible even across crashes,
 * job retries, or concurrent pollers — call it right before sending to Discord.
 *
 * Fails OPEN (returns true) on a ledger error so a transient DB hiccup never
 * silently blocks a legitimate delivery; the cheap last_post_id check still
 * guards the common repeat case.
 */
export async function claimYouTubeDelivery(
  supabase: SupabaseClient,
  input: { sourceId: number; youtubeId: string; kind: string; channelId?: string | null },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('muel_youtube_deliveries')
    .upsert(
      {
        source_id: input.sourceId,
        youtube_id: input.youtubeId,
        kind: input.kind,
        channel_id: input.channelId ?? null,
        delivered_at: new Date().toISOString(),
      },
      { onConflict: 'source_id,youtube_id', ignoreDuplicates: true },
    )
    .select('youtube_id');

  if (error) {
    console.warn('[youtube] delivery claim failed (continuing)', error);
    return true;
  }
  // ignoreDuplicates => conflicting rows are NOT returned. A non-empty result
  // means THIS caller inserted the row (first delivery); empty means it existed.
  return Array.isArray(data) && data.length > 0;
}

export async function getYouTubeItemByOrigin(
  supabase: SupabaseClient,
  originTable: string,
  originId: string,
): Promise<StoredYouTubeItem | null> {
  const kind = originTable === 'youtube_video' ? ['video', 'shorts'] : ['community_post'];
  const { data, error } = await supabase
    .from('muel_youtube_items')
    .select('*')
    .eq('youtube_id', originId)
    .in('kind', kind)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[youtube] failed to load item cache', error);
    return null;
  }
  return (data ?? null) as StoredYouTubeItem | null;
}

export async function formatRecentYouTubeItemsForContext(
  supabase: SupabaseClient,
  limit = 5,
): Promise<string> {
  const { data, error } = await supabase
    .from('muel_youtube_items')
    .select('kind,youtube_id,channel_title,title,description,url,published_at,statistics,tags')
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return '';

  const lines = ['--- Recent YouTube Items ---'];
  for (const row of data as Array<StoredYouTubeItem>) {
    const label = row.kind === 'community_post' ? '게시글' : row.kind === 'shorts' ? '쇼츠' : '영상';
    const stats = formatPublicViewCount(row.statistics, row.metadata);
    const tags = row.tags?.length ? ` · tags: ${row.tags.slice(0, 5).join(', ')}` : '';
    lines.push(`[${label}] ${row.channel_title ?? 'YouTube'} - ${row.title ?? row.youtube_id}${stats}${tags}`);
    const description = truncate(row.description, 280);
    if (description) lines.push(description);
    lines.push(row.url);
    lines.push('');
  }
  lines.push('--- End YouTube Items ---');
  return lines.join('\n');
}

export function buildResearchTopicFromItem(originTable: string, item: StoredYouTubeItem): string {
  const label = originTable === 'youtube_video'
    ? item.kind === 'shorts' ? 'YouTube 쇼츠' : 'YouTube 영상'
    : 'YouTube 커뮤니티 게시글';
  const stats = item.statistics ?? {};
  const youtubeMetadata = item.metadata?.youtube as Record<string, unknown> | undefined;
  const fields = [
    `조사 대상: ${label}`,
    item.channel_title ? `채널: ${item.channel_title}` : '',
    item.title ? `제목: ${item.title}` : '',
    item.published_at ? `게시일: ${item.published_at}` : '',
    `URL: ${item.url}`,
    item.description ? `설명/본문: ${truncate(item.description, 700)}` : '',
    item.tags?.length ? `태그: ${item.tags.slice(0, 12).join(', ')}` : '',
    item.category_id ? `카테고리 ID: ${item.category_id}` : '',
    item.duration ? `길이: ${item.duration}` : '',
    [stats.viewCount ? formatPublicViewCount(stats, item.metadata).replace(/^ · /, '') : '', stats.likeCount ? `좋아요 ${stats.likeCount}` : '', stats.commentCount ? `댓글 ${stats.commentCount}` : ''].filter(Boolean).join(', '),
    item.topic_categories?.length ? `YouTube topic categories: ${item.topic_categories.join(', ')}` : '',
    youtubeMetadata?.liveBroadcastContent && youtubeMetadata.liveBroadcastContent !== 'none'
      ? `라이브 상태: ${String(youtubeMetadata.liveBroadcastContent)}`
      : '',
    youtubeMetadata?.containsSyntheticMedia === true ? 'YouTube 표시: 합성·변형 미디어 포함' : '',
    youtubeMetadata?.hasPaidProductPlacement === true ? 'YouTube 표시: 유료 프로모션 포함' : '',
    youtubeMetadata?.brandPartnerChannelId
      ? `브랜드 파트너 채널: ${String(youtubeMetadata.brandPartnerChannelId)}`
      : '',
  ].filter(Boolean);

  return `${fields.join('\n')}\n\n위 사전 정보를 기준으로 배경, 최근 동향, 공식 발표, 관련 맥락, 사용자 반응을 한국어로 정리하고 출처를 인용해줘. 사전 정보와 충돌하는 내용은 검증해서 알려줘.`;
}

export function buildVideoItemInput(args: {
  sourceId: number;
  latest: {
    id: string;
    title: string;
    content: string;
    link: string;
    author: string;
    published: string;
    isShorts?: boolean;
  };
  metadata: YouTubeVideoMetadata | null;
  channel: YouTubeChannelMetadata | null;
}): YouTubeItemUpsert {
  const metadata = args.metadata;
  const refreshedAt = metadata ? new Date().toISOString() : null;
  return {
    sourceId: args.sourceId,
    kind: args.latest.isShorts ? 'shorts' : 'video',
    youtubeId: args.latest.id,
    channelId: metadata?.channelId ?? args.channel?.channelId ?? null,
    channelTitle: metadata?.channelTitle ?? args.channel?.title ?? args.latest.author,
    title: metadata?.title ?? args.latest.title,
    description: metadata?.description ?? args.latest.content,
    url: args.latest.link,
    publishedAt: metadata?.publishedAt ?? args.latest.published,
    isShorts: Boolean(args.latest.isShorts),
    tags: metadata?.tags ?? [],
    categoryId: metadata?.categoryId ?? null,
    duration: metadata?.duration ?? null,
    statistics: {
      viewCount: metadata?.viewCount ?? null,
      likeCount: metadata?.likeCount ?? null,
      commentCount: metadata?.commentCount ?? null,
    },
    topicCategories: metadata?.topicCategories ?? [],
    raw: {
      source: 'videos.xml+youtube_data_api',
      viewCountSemantics: YOUTUBE_PUBLIC_VIEW_COUNT_SEMANTICS,
      viewCountEffectiveAt: YOUTUBE_PUBLIC_VIEW_COUNT_EFFECTIVE_AT,
      channel: args.channel,
      youtube: metadata,
    },
    apiRefreshedAt: refreshedAt,
    statsRefreshedAt: refreshedAt,
  };
}

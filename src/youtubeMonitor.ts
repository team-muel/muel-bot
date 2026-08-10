import { Client } from 'discord.js';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';
import {
  scrapeLatestCommunityPostByChannelId,
  scrapeLatestCommunityPostByInnerTube,
  type ScrapedCommunityPost,
} from './youtubeCommunityScraper.js';
import { parseYouTubeChannelId } from './youtubeSubscriptionStore.js';
import { fetchWithTimeout } from './utils/network.js';
import { cachePost } from './youtubePostCache.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import { renderDiscordComponentsV2WithFallback } from './rendering/discordComponentsV2.js';
import { insertWeaveNode } from './weaveNodes.js';
import type { MuelRenderablePart, RenderTone } from './rendering/types.js';
import { enqueueJob } from './muelJobs.js';
import { getPrimaryTextModel } from './modelRegistry.js';
import { logMuelBackgroundAiEvent } from './muelAiEvents.js';
import {
  fetchYouTubeChannelMetadata,
  fetchYouTubeUploadsPlaylistItems,
  fetchYouTubeVideoMetadata,
  type YouTubeVideoMetadata,
} from './youtubeMetadataClient.js';
import { buildVideoItemInput, claimYouTubeDelivery, upsertYouTubeItem } from './youtubeItemStore.js';
import { postOverflowToThread } from './rendering/discordDelivery.js';
import { safeBreakIndex } from './rendering/discordText.js';
import { renewYouTubeWebSubSubscriptions } from './youtubeWebSub.js';
import { runYouTubeApiDataLifecycle } from './youtubeLifecycle.js';
import { mapWithConcurrency } from './utils/concurrency.js';
import { isSupabaseDataApiRestricted } from './serviceRestriction.js';

type SourceRow = {
  id: number;
  channel_id: string | null;
  name: string | null;
  url: string;
  is_active: boolean;
  last_post_id: string | null;
  last_post_signature: string | null;
  last_check_at: string | null;
};

type LatestEntry = {
  id: string;
  title: string;
  content: string;
  link: string;
  author: string;
  published: string;
  isShorts?: boolean;
  images?: string[];
};

let timer: NodeJS.Timeout | null = null;
let webSubTimer: NodeJS.Timeout | null = null;
let lifecycleTimer: NodeJS.Timeout | null = null;
let lifecycleRunning = false;
let running = false;
let lastTickStartedAt: string | null = null;
let lastTickFinishedAt: string | null = null;
let lastTickStatus: 'idle' | 'success' | 'error' | 'restricted' = 'idle';
let lastTickMessage: string | null = null;
let lastTickChecked = 0;
let lastTickSent = 0;

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
};

const getDiscordErrorCode = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; rawError?: { code?: unknown } };
  const code = candidate.code ?? candidate.rawError?.code;
  return typeof code === 'number' ? code : null;
};

const isOrphanedDiscordDestination = (error: unknown): boolean => {
  const code = getDiscordErrorCode(error);
  return code === 50001 || code === 50013 || code === 10003 || code === 10004;
};

const decodeXml = (value: string): string => {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
};

const extractTag = (xml: string, tag: string): string => {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ? decodeXml(match[1]) : '';
};

const detectShortsVideo = async (videoId: string): Promise<boolean> => {
  try {
    const response = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; MuelBot/1.0)',
          accept: 'text/html,application/xhtml+xml',
        },
      },
      Math.min(config.youtubeFetchTimeoutMs, 8000),
    );

    if (!response.ok) return false;
    const html = await response.text();
    return html.includes('"isShortsEligible":true') || html.includes('"shortsLockupViewModel"') || html.includes('"reelWatchEndpoint"');
  } catch {
    return false;
  }
};

const getMode = (row: SourceRow): 'posts' | 'videos' => {
  const name = String(row.name ?? '').toLowerCase();
  if (row.url.endsWith('#posts') || name.includes('posts')) {
    return 'posts';
  }
  return 'videos';
};

const isYouTubeRow = (row: SourceRow): boolean => {
  const name = String(row.name ?? '').toLowerCase();
  const url = String(row.url ?? '').toLowerCase();
  return row.is_active && Boolean(row.channel_id) && (name.startsWith('youtube-') || url.includes('youtube.com/') || url.includes('youtu.be/'));
};

const loadRows = async (): Promise<SourceRow[]> => {
  const { data, error } = await getSupabaseClient()
    .from('sources')
    .select('id,channel_id,name,url,is_active,last_post_id,last_post_signature,last_check_at')
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  return ((data ?? []) as SourceRow[]).filter(isYouTubeRow);
};

export const parseYouTubeVideoFeed = (xml: string): LatestEntry[] => {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  return entries.flatMap((match) => {
    const entry = match[1] ?? '';
    const id = extractTag(entry, 'yt:videoId') || extractTag(entry, 'id').split(':').pop() || '';
    if (!id) return [];
    const title = extractTag(entry, 'title');
    const author = extractTag(entry, 'name') || 'YouTube Channel';
    const published = extractTag(entry, 'published');
    return [{
      id,
      title: title || 'YouTube video',
      content: title || '',
      link: `https://www.youtube.com/watch?v=${id}`,
      author,
      published,
    }];
  });
};

export const selectUnseenVideoEntries = (
  entries: LatestEntry[],
  previousVideoId: string | null,
): LatestEntry[] => {
  const chronological = [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.published);
    const rightTime = Date.parse(right.published);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
    return 0;
  });
  if (chronological.length === 0) return [];
  if (!previousVideoId) return [chronological[chronological.length - 1]!];
  const previousIndex = chronological.findIndex((entry) => entry.id === previousVideoId);
  if (previousIndex < 0) return [];
  return chronological.slice(previousIndex + 1);
};

const fetchRecentVideos = async (channelId: string): Promise<LatestEntry[]> => {
  const response = await fetchWithTimeout(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    {
      headers: {
        'user-agent': 'MuelBot/1.0',
        accept: 'application/atom+xml,application/xml,text/xml',
      },
    },
    config.youtubeFetchTimeoutMs,
  );

  if (!response.ok) {
    return [];
  }

  return parseYouTubeVideoFeed(await response.text());
};

const recoverVideoEntries = async (
  channelId: string,
  row: SourceRow,
  feedEntries: LatestEntry[],
): Promise<LatestEntry[]> => {
  if (!config.youtubeDataApiKey) {
    return feedEntries.slice(0, 1);
  }

  try {
    const channel = await fetchYouTubeChannelMetadata(channelId);
    if (!channel?.uploadsPlaylistId) return feedEntries.slice(0, 1);
    const uploads = await fetchYouTubeUploadsPlaylistItems(channel.uploadsPlaylistId, 50);
    const entries = uploads.map((item): LatestEntry => ({
      id: item.videoId,
      title: item.title,
      content: item.description || item.title,
      link: `https://www.youtube.com/watch?v=${item.videoId}`,
      author: item.channelTitle ?? 'YouTube Channel',
      published: item.publishedAt ?? '',
    }));
    const fromPrevious = selectUnseenVideoEntries(entries, row.last_post_id);
    if (fromPrevious.length > 0) return fromPrevious;

    const cutoff = row.last_check_at ? Date.parse(row.last_check_at) : Number.NaN;
    if (Number.isFinite(cutoff)) {
      return entries
        .filter((entry) => {
          const published = Date.parse(entry.published);
          return Number.isFinite(published) && published > cutoff;
        })
        .sort((left, right) => Date.parse(left.published) - Date.parse(right.published));
    }
    const newest = [...entries].sort(
      (left, right) => Date.parse(left.published) - Date.parse(right.published),
    ).at(-1);
    return newest ? [newest] : feedEntries.slice(0, 1);
  } catch (error) {
    console.warn('[youtube] uploads playlist reconciliation failed', {
      channelId,
      sourceId: row.id,
      error,
    });
    return feedEntries.slice(0, 1);
  }
};

const toLatestEntry = (post: ScrapedCommunityPost): LatestEntry => ({
  id: post.id,
  title: post.title,
  content: post.content,
  link: post.link,
  author: post.author,
  published: post.published,
  images: post.images,
});

const truncate = (input: string, maxLength: number): string => {
  const text = String(input || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}...`;
};

const splitCommunityBody = (input: string): { preview: string; overflow: string } => {
  const text = String(input || '').replace(/\r\n/g, '\n').trim();
  const maxPreviewLength = 1950;
  if (text.length <= maxPreviewLength) {
    return { preview: text, overflow: '' };
  }

  // URL-safe boundary: never split inside a link when carving preview/overflow.
  const at = safeBreakIndex(text, maxPreviewLength);
  return {
    preview: text.slice(0, at).trim(),
    overflow: text.slice(at).trim(),
  };
};

const isShortsEntry = (latest: LatestEntry): boolean => {
  const markerText = `${latest.title}\n${latest.content}\n${latest.link}`;
  return Boolean(latest.isShorts) || /(^|\W)(#shorts|shorts|쇼츠)(\W|$)/i.test(markerText) || latest.link.includes('/shorts/');
};

const displayLink = (latest: LatestEntry): string => {
  if (isShortsEntry(latest)) {
    return `https://www.youtube.com/shorts/${latest.id}`;
  }
  return latest.link;
};

const threadTitle = (prefix: string, latest: LatestEntry): string =>
  truncate(`${prefix} ${latest.title || latest.author}`, 90);

const fetchLatestCommunityPost = async (
  row: SourceRow,
): Promise<{ latest: LatestEntry; channelId: string } | null> => {
  const channelId = await parseYouTubeChannelId(row.url);
  if (!channelId) {
    return null;
  }

  if (!config.youtubeCommunityEnabled) return null;
  const post = await scrapeLatestCommunityPostByInnerTube(
    channelId,
    config.youtubeFetchTimeoutMs,
  ) ?? await scrapeLatestCommunityPostByChannelId(
    channelId,
    config.youtubeFetchTimeoutMs,
  );
  return post ? { latest: toLatestEntry(post), channelId } : null;
};

const CommunityPostSchema = z.object({
  title: z.string().describe('한국어 Discord 카드 제목. 최대 50자. 원문 핵심을 충실히 요약한다.'),
  subtitle: z.string().optional().describe('선택 한국어 한 줄 설명. 최대 100자. 유용한 맥락이 없으면 생략한다.'),
  body: z.string().describe('한국어 본문. 원문의 사실, 숫자, 날짜, 링크, 고유명사는 보존하고 없는 내용을 만들지 않는다.'),
  highlights: z.array(z.string()).optional().describe('선택 한국어 bullet 항목. 날짜, 링크, 보상, 일정처럼 중요한 항목만 포함한다.'),
});
export type EditedCommunityPost = z.infer<typeof CommunityPostSchema>;

const PRESERVED_LITERAL_RES = [
  /https?:\/\/\S+/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/g,
  /\b\d{1,3}(?:,\d{3})+\b/g,
  /\b\d+(?:\.\d+)?%/g,
  /\b\d{1,2}\s?(?:AM|PM|am|pm)\b/g,
  /\b[A-Z][A-Za-z]+:\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\b/g,
  /\b[A-Z][A-Z0-9]{2,}\b/g,
];

const preserveSourceLiterals = (rawContent: string, data: EditedCommunityPost): EditedCommunityPost => {
  const literals = [...new Set(PRESERVED_LITERAL_RES.flatMap((re) => rawContent.match(re) ?? []))];
  if (literals.length === 0) return data;

  const rendered = [
    data.title,
    data.subtitle ?? '',
    data.body,
    ...(data.highlights ?? []),
  ].join('\n');
  const missing = literals.filter((literal) => !rendered.includes(literal));
  if (missing.length === 0) return data;

  return {
    ...data,
    body: [data.body, `원문 표기: ${missing.join(', ')}`].filter(Boolean).join('\n'),
  };
};

export const editCommunityPost = async (authorName: string, rawContent: string): Promise<{ data: EditedCommunityPost, modelId: string } | null> => {
  const resolvedModel = getPrimaryTextModel('summary');
  if (!resolvedModel) {
    return null;
  }

  const supabase = getSupabaseClient();
  const startedAt = Date.now();

  try {
    const { output: object, usage, providerMetadata } = await generateText({
      model: resolvedModel.model,
      output: Output.object({ schema: CommunityPostSchema }),
      prompt: `You are editing a YouTube community post from channel "${authorName}" into a concise Discord embed card for Korean Discord users.

Rules:
- Write the title, subtitle, body, and highlights in natural Korean by default.
- If the source is English, Japanese, or another language, translate the meaning into Korean.
- Preserve every fact, number, date, link, event name, game title, person name, and proper noun that you include.
- Do not add, infer, or rewrite facts that are not present in the source.
- If a source detail is ambiguous, keep the original wording instead of guessing.
- Keep official titles, URLs, character names, and product names unchanged when translating them would be misleading.
- Preserve exact URL and time expressions such as "8 PM"; do not translate or normalize them.
- Keep the tone neutral and editorial. Do not turn the post into exaggerated marketing copy.
- Use Markdown only when it improves readability.

Source post:
${rawContent}`,
      temperature: 0.1, // Lower temperature for faithfulness
    });
    void logMuelBackgroundAiEvent(supabase, {
      source: 'youtube_monitor',
      status: 'success',
      taskType: 'summary',
      resolvedModel: { provider: resolvedModel.provider, modelId: resolvedModel.modelId, task: resolvedModel.task },
      startedAt,
      usage,
      providerMetadata,
      metadata: { step: 'edit_community_post', authorName },
    });
    return { data: preserveSourceLiterals(rawContent, object), modelId: resolvedModel.modelId };
  } catch (error) {
    const errClass = error instanceof Error ? error.name : typeof error;
    const errMsg = error instanceof Error ? error.message : String(error);
    const isSchemaFailure = errClass === 'AI_NoObjectGeneratedError' || errMsg.includes('did not match schema');
    void logMuelBackgroundAiEvent(supabase, {
      source: 'youtube_monitor',
      status: isSchemaFailure ? 'fallback' : 'error',
      taskType: 'summary',
      resolvedModel: { provider: resolvedModel.provider, modelId: resolvedModel.modelId, task: resolvedModel.task },
      startedAt,
      errorClass: errClass,
      errorMessage: errMsg.slice(0, 240),
      fallbackReason: isSchemaFailure ? 'summary_schema_match_failed' : null,
      metadata: { step: 'edit_community_post', authorName },
    });
    console.warn('[youtube] failed to edit community post with AI', error);
    return null;
  }
};

const updateRow = async (row: SourceRow, latest: LatestEntry): Promise<void> => {
  const common = {
    last_check_status: 'success',
    last_check_error: null,
    last_check_at: new Date().toISOString(),
  };
  const patch = getMode(row) === 'posts'
    ? { ...common, last_post_signature: latest.id }
    : { ...common, last_post_id: latest.id };

  const { error } = await getSupabaseClient().from('sources').update(patch).eq('id', row.id);
  if (error) {
    throw error;
  }
};

const updateRowNoLatest = async (row: SourceRow): Promise<void> => {
  const { error } = await getSupabaseClient()
    .from('sources')
    .update({
      last_check_status: 'no_latest',
      last_check_error: null,
      last_check_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (error) {
    throw error;
  }
};

const updateRowError = async (row: SourceRow, error: unknown): Promise<void> => {
  const message = formatUnknownError(error);
  const orphanedDestination = isOrphanedDiscordDestination(error);
  await getSupabaseClient()
    .from('sources')
    .update({
      is_active: orphanedDestination ? false : row.is_active,
      last_check_status: orphanedDestination ? 'disabled_orphaned_discord_destination' : 'error',
      last_check_error: orphanedDestination
        ? `Disabled source because Discord destination is inaccessible: ${message}`.slice(0, 1000)
        : message.slice(0, 1000),
      last_check_at: new Date().toISOString(),
    })
    .eq('id', row.id);
};

const processVideoRow = async (client: Client, row: SourceRow): Promise<number> => {
  const channelId = await parseYouTubeChannelId(row.url);
  if (!channelId) {
    await updateRowNoLatest(row);
    return 0;
  }

  const entries = await fetchRecentVideos(channelId);
  if (entries.length === 0) {
    await updateRowNoLatest(row);
    return 0;
  }

  let candidates = selectUnseenVideoEntries(entries, row.last_post_id);
  if (
    candidates.length === 0
    && row.last_post_id
    && !entries.some((entry) => entry.id === row.last_post_id)
  ) {
    candidates = await recoverVideoEntries(channelId, row, entries);
  }
  if (candidates.length === 0) {
    // This is the critical quota fast path: unchanged feeds do not touch the
    // Data API, video watch HTML, or the YouTube item table.
    if (entries.some((entry) => entry.id === row.last_post_id) && Math.random() < 0.05) {
      await updateRow(row, entries.find((entry) => entry.id === row.last_post_id)!);
    }
    return 0;
  }

  const channel = await client.channels.fetch(row.channel_id!);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
    throw new Error(`Discord channel is not sendable: ${row.channel_id}`);
  }

  let sent = 0;
  for (const candidate of candidates) {
    // Shorts remain a discovery by-product. Probe only a genuinely new upload,
    // then advance the source cursor without caching or delivering it.
    const isShorts = await detectShortsVideo(candidate.id);
    const latest: LatestEntry = { ...candidate, isShorts };
    if (config.youtubeSuppressShorts && isShorts) {
      await updateRow(row, latest);
      continue;
    }

    let videoMetadata: YouTubeVideoMetadata | null = null;
    if (config.youtubeDataApiKey) {
      try {
        videoMetadata = await fetchYouTubeVideoMetadata(latest.id);
      } catch (error) {
        console.warn('[youtube] video metadata fetch failed', error);
      }
    }

    await upsertYouTubeItem(
      getSupabaseClient(),
      buildVideoItemInput({
        sourceId: row.id,
        latest: {
          ...latest,
          link: displayLink(latest),
          isShorts,
        },
        metadata: videoMetadata,
        channel: null,
      }),
    );

    const claimed = await claimYouTubeDelivery(getSupabaseClient(), {
      sourceId: row.id,
      youtubeId: latest.id,
      kind: isShorts ? 'shorts' : 'video',
      channelId: row.channel_id,
    });
    if (!claimed) {
      await updateRow(row, latest);
      continue;
    }

    const intent: MuelRenderablePart[] = [{
      type: 'video-card',
      title: videoMetadata?.title ?? latest.title,
      author: videoMetadata?.channelTitle ?? latest.author,
      url: displayLink(latest),
      isShorts,
      videoId: latest.id,
      publishedAt: videoMetadata?.publishedAt ?? latest.published,
      actionButtons: config.aiqEnabled
        ? [{
            label: '이 소식 더 알아보기',
            customId: `research:enrich:youtube_video:${latest.id}`,
            style: 'secondary' as const,
          }]
        : undefined,
    }];
    await channel.send(renderDiscordMessage(intent));

    void insertWeaveNode({
      sourceKind: 'community_video',
      visibility: 'community',
      title: videoMetadata?.title ?? latest.title,
      body: videoMetadata?.description || latest.title,
      tags: [videoMetadata?.channelTitle ?? latest.author].filter(Boolean),
      sourceRef: {
        youtube_id: latest.id,
        channel_id: channelId,
        url: displayLink(latest),
        is_shorts: isShorts,
      },
    });

    if (latest.content) {
      cachePost({
        id: latest.id,
        title: latest.title,
        content: latest.content,
        author: latest.author,
        link: latest.link,
        published: latest.published,
        cachedAt: Date.now(),
      });
    }
    await updateRow(row, latest);
    sent += 1;
  }
  return sent;
};

const processCommunityRow = async (client: Client, row: SourceRow): Promise<number> => {
  const fetched = await fetchLatestCommunityPost(row);
  if (!fetched) {
    await updateRowNoLatest(row);
    return 0;
  }
  const { latest, channelId } = fetched;

  if (row.last_post_signature === latest.id) {
    if (Math.random() < 0.05) {
      await updateRow(row, latest);
    }
    return 0;
  }

  const channel = await client.channels.fetch(row.channel_id!);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
    throw new Error(`Discord channel is not sendable: ${row.channel_id}`);
  }

  await upsertYouTubeItem(getSupabaseClient(), {
    sourceId: row.id,
    kind: 'community_post',
    youtubeId: latest.id,
    channelId,
    channelTitle: latest.author,
    title: latest.title,
    description: latest.content,
    url: displayLink(latest),
    publishedAt: latest.published || null,
    isShorts: false,
    raw: {
      source: 'youtube_community_experimental',
      images: latest.images ?? [],
    },
  });

  // Idempotency gate: atomically claim this item BEFORE sending. If it was
  // already delivered (crash-after-send, job retry, or a concurrent poller) the
  // claim fails and we skip re-sending — this is the fix for duplicate posts.
  // We still persist the cheap marker so the fast path skips it next tick.
  const claimed = await claimYouTubeDelivery(getSupabaseClient(), {
    sourceId: row.id,
    youtubeId: latest.id,
    kind: 'community_post',
    channelId: row.channel_id,
  });
  if (!claimed) {
    await updateRow(row, latest);
    return 0;
  }

  const { preview, overflow } = splitCommunityBody(latest.content);

  let intentBase: MuelRenderablePart = {
    type: 'youtube-community-post-card',
    id: latest.id,
    tone: 'neutral',
    authorName: latest.author,
    body: preview,
    sourceUrl: displayLink(latest),
    publishedAt: latest.published,
    imageUrls: latest.images,
    metadata: {
      editor: 'heuristic',
      editedAt: new Date().toISOString(),
    },
  };

  // Attempt to use AI to edit the post
  const aiResult = await editCommunityPost(latest.author, latest.content);
  if (aiResult) {
    intentBase = {
      ...intentBase,
      title: aiResult.data.title,
      subtitle: aiResult.data.subtitle,
      body: aiResult.data.body,
      highlights: aiResult.data.highlights,
      metadata: {
        editor: 'ai',
        editorModel: aiResult.modelId,
        editedAt: new Date().toISOString(),
      },
    };
  } else {
    // Fallback heuristic
    const firstNewline = preview.indexOf('\n');
    if (firstNewline !== -1) {
      const firstLine = preview.slice(0, firstNewline).trim();
      if (firstLine.length > 0 && firstLine.length <= 100) {
        intentBase.title = firstLine;
        intentBase.body = preview.slice(firstNewline + 1).trim();
      }
    } else if (preview.length > 0 && preview.length <= 100) {
      intentBase.title = preview;
      intentBase.body = '';
    }
  }

  if (config.aiqEnabled) {
    intentBase.actionButtons = [
      {
        label: '이 소식 더 알아보기',
        customId: `research:enrich:youtube_post:${latest.id}`,
        style: 'secondary' as const,
      },
    ];
  }
  const intent: MuelRenderablePart[] = [intentBase];

  const communityMessage = config.discordComponentsV2Mode === 'off'
    ? renderDiscordMessage(intent)
    : renderDiscordComponentsV2WithFallback(intent);
  const sentMessage = await channel.send(communityMessage);

  void insertWeaveNode({
    sourceKind: 'community_post',
    visibility: 'community',
    title: latest.title,
    body: latest.content || latest.title,
    tags: [latest.author].filter(Boolean),
    sourceRef: {
      youtube_id: latest.id,
      channel_id: channelId,
      url: displayLink(latest),
    },
  });

  if (overflow) {
    await postOverflowToThread(sentMessage, threadTitle('이어서 보기', latest), overflow, {
      footer: displayLink(latest),
    });
  }

  if (latest.content) {
    cachePost({
      id: latest.id,
      title: latest.title,
      content: latest.content,
      author: latest.author,
      link: latest.link,
      published: latest.published,
      cachedAt: Date.now(),
    });
  }

  await updateRow(row, latest);
  return 1;
};

const processRow = async (client: Client, row: SourceRow): Promise<number> => {
  if (getMode(row) === 'videos') {
    return processVideoRow(client, row);
  }
  return processCommunityRow(client, row);
};

export const runYouTubeMonitorTick = async (client: Client): Promise<void> => {
  if (isSupabaseDataApiRestricted()) {
    lastTickStatus = 'restricted';
    lastTickMessage = 'skipped=supabase_data_api_restricted';
    return;
  }
  if (running) {
    return;
  }

  running = true;
  lastTickStartedAt = new Date().toISOString();
  lastTickStatus = 'idle';
  lastTickMessage = null;
  try {
    const rows = await loadRows();
    const sentByRow = await mapWithConcurrency(
      rows,
      config.youtubeMonitorConcurrency,
      async (row): Promise<number> => {
        try {
          return await processRow(client, row);
        } catch (error) {
          console.warn(`[youtube] row ${row.id} failed`, error);
          try {
            await updateRowError(row, error);
          } catch (statusError) {
            console.warn(`[youtube] row ${row.id} error status update failed`, statusError);
          }
          return 0;
        }
      },
    );
    const sent = sentByRow.reduce((total, count) => total + count, 0);

    lastTickChecked = rows.length;
    lastTickSent = sent;
    lastTickStatus = 'success';
    lastTickMessage = `checked=${rows.length} sent=${sent}`;
    if (sent > 0) {
      console.log(`[youtube] tick checked=${rows.length} sent=${sent}`);
    }
  } catch (error) {
    const message = formatUnknownError(error);
    lastTickStatus = 'error';
    lastTickMessage = message;
    console.warn('[youtube] tick failed', error);
  } finally {
    lastTickFinishedAt = new Date().toISOString();
    running = false;
  }
};

export const requestYouTubeMonitorSync = (
  client: Client,
  trigger: 'timer' | 'websub' = 'timer',
): void => {
  if (isSupabaseDataApiRestricted()) {
    lastTickStatus = 'restricted';
    lastTickMessage = `skipped=supabase_data_api_restricted trigger=${trigger}`;
    return;
  }
  if (!config.enableJobWorker) {
    void runYouTubeMonitorTick(client);
    return;
  }

  const bucketSize = trigger === 'websub' ? 15_000 : config.youtubeMonitorIntervalMs;
  const bucket = Math.floor(Date.now() / Math.max(bucketSize, 1));
  void enqueueJob(
    getSupabaseClient(),
    'sync_youtube_sources',
    { requestedAt: new Date().toISOString(), trigger },
    `sync_youtube_sources:${trigger}:${bucket}`,
  ).catch((error) => {
    console.warn('[youtube] failed to enqueue sync job', error);
  });
};

export const startYouTubeMonitor = (client: Client): void => {
  if (timer) {
    return;
  }

  const requestTick = () => {
    requestYouTubeMonitorSync(client);
  };
  const renewWebSub = () => {
    if (isSupabaseDataApiRestricted()) return;
    void renewYouTubeWebSubSubscriptions()
      .then(({ attempted, accepted }) => {
        if (attempted > 0) {
          console.log('[youtube-websub] renewal requested', { attempted, accepted });
        }
      })
      .catch((error) => {
        console.warn('[youtube-websub] renewal failed', error);
      });
  };
  const runLifecycle = () => {
    if (lifecycleRunning || isSupabaseDataApiRestricted()) return;
    lifecycleRunning = true;
    void runYouTubeApiDataLifecycle()
      .then((result) => {
        if (result.metadataRefreshed || result.deleted || result.statsRefreshed || result.failed) {
          console.log('[youtube-lifecycle] maintenance complete', result);
        }
      })
      .catch((error) => {
        console.warn('[youtube-lifecycle] maintenance failed', error);
      })
      .finally(() => {
        lifecycleRunning = false;
      });
  };

  requestTick();
  timer = setInterval(requestTick, config.youtubeMonitorIntervalMs);
  if (config.youtubeWebSubEnabled && config.youtubeWebSubCallbackUrl) {
    renewWebSub();
    webSubTimer = setInterval(renewWebSub, config.youtubeWebSubRenewIntervalMs);
  }
  runLifecycle();
  lifecycleTimer = setInterval(runLifecycle, config.youtubeLifecycleIntervalMs);
};

export const getYouTubeMonitorStatus = () => ({
  running,
  intervalMs: config.youtubeMonitorIntervalMs,
  concurrency: config.youtubeMonitorConcurrency,
  lastTickStartedAt,
  lastTickFinishedAt,
  lastTickStatus,
  lastTickMessage,
  lastTickChecked,
  lastTickSent,
  webSubEnabled: config.youtubeWebSubEnabled,
  webSubConfigured: Boolean(config.youtubeWebSubCallbackUrl),
  webSubRenewing: Boolean(webSubTimer),
  lifecycleRunning,
  lifecycleScheduled: Boolean(lifecycleTimer),
});

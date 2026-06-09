import { Client, ThreadAutoArchiveDuration, Message } from 'discord.js';
import { generateObject } from 'ai';
import { z } from 'zod';
import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';
import { scrapeLatestCommunityPostByInnerTube, type ScrapedCommunityPost } from './youtubeCommunityScraper.js';
import { parseYouTubeChannelId } from './youtubeSubscriptionStore.js';
import { fetchWithTimeout } from './utils/network.js';
import { cachePost } from './youtubePostCache.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import { insertWeaveNode } from './weaveNodes.js';
import type { MuelRenderablePart, RenderTone } from './rendering/types.js';
import { enqueueJob } from './muelJobs.js';
import { getPrimaryTextModel } from './modelRegistry.js';
import { logMuelBackgroundAiEvent } from './muelAiEvents.js';
import { fetchYouTubeChannelMetadata, fetchYouTubeVideoMetadata, type YouTubeChannelMetadata, type YouTubeVideoMetadata } from './youtubeMetadataClient.js';
import { buildVideoItemInput, upsertYouTubeItem } from './youtubeItemStore.js';

type SourceRow = {
  id: number;
  channel_id: string | null;
  name: string | null;
  url: string;
  is_active: boolean;
  last_post_id: string | null;
  last_post_signature: string | null;
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

type LatestWithMetadata = {
  latest: LatestEntry;
  channelId: string;
  videoMetadata: YouTubeVideoMetadata | null;
  channelMetadata: YouTubeChannelMetadata | null;
};

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastTickStartedAt: string | null = null;
let lastTickFinishedAt: string | null = null;
let lastTickStatus: 'idle' | 'success' | 'error' = 'idle';
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
    .select('id,channel_id,name,url,is_active,last_post_id,last_post_signature')
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  return ((data ?? []) as SourceRow[]).filter(isYouTubeRow);
};

const fetchLatestVideo = async (channelId: string): Promise<LatestEntry | null> => {
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
    return null;
  }

  const xml = await response.text();
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch?.[1]) {
    return null;
  }

  const entry = entryMatch[1];
  const id = extractTag(entry, 'yt:videoId') || extractTag(entry, 'id').split(':').pop() || '';
  const title = extractTag(entry, 'title');
  const author = extractTag(entry, 'name') || 'YouTube Channel';
  const published = extractTag(entry, 'published');

  if (!id) {
    return null;
  }

  return {
    id,
    title: title || 'YouTube video',
    content: title || '',
    link: `https://www.youtube.com/watch?v=${id}`,
    author,
    published,
    isShorts: await detectShortsVideo(id),
  };
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

const splitDiscordMessages = (input: string, maxLength = 1800): string[] => {
  const text = String(input || '').trim();
  if (!text) return [];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const preferredBreak = remaining.lastIndexOf('\n', maxLength);
    const splitAt = preferredBreak > 200 ? preferredBreak : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

const splitCommunityBody = (input: string): { preview: string; overflow: string } => {
  const text = String(input || '').trim();
  const maxPreviewLength = 1950;
  if (text.length <= maxPreviewLength) {
    return { preview: text, overflow: '' };
  }

  const newlineBreak = text.lastIndexOf('\n', maxPreviewLength);
  if (newlineBreak > 400) {
    return {
      preview: text.slice(0, newlineBreak).trim(),
      overflow: text.slice(newlineBreak).trim(),
    };
  }

  const spaceBreak = text.lastIndexOf(' ', maxPreviewLength);
  const splitAt = spaceBreak > 400 ? spaceBreak : maxPreviewLength;
  return {
    preview: text.slice(0, splitAt).trim(),
    overflow: text.slice(splitAt).trim(),
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

const fetchLatest = async (row: SourceRow): Promise<LatestWithMetadata | null> => {
  const channelId = await parseYouTubeChannelId(row.url);
  if (!channelId) {
    return null;
  }

  if (getMode(row) === 'posts') {
    const post = await scrapeLatestCommunityPostByInnerTube(channelId, config.youtubeFetchTimeoutMs);
    return post
      ? { latest: toLatestEntry(post), channelId, videoMetadata: null, channelMetadata: null }
      : null;
  }

  const latest = await fetchLatestVideo(channelId);
  if (!latest) return null;

  let videoMetadata: YouTubeVideoMetadata | null = null;
  let channelMetadata: YouTubeChannelMetadata | null = null;
  if (config.youtubeDataApiKey) {
    try {
      videoMetadata = await fetchYouTubeVideoMetadata(latest.id);
    } catch (error) {
      console.warn('[youtube] video metadata fetch failed', error);
    }
    try {
      channelMetadata = await fetchYouTubeChannelMetadata(videoMetadata?.channelId ?? channelId);
    } catch (error) {
      console.warn('[youtube] channel metadata fetch failed', error);
    }
  }

  return { latest, channelId, videoMetadata, channelMetadata };
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
    const { object, usage } = await generateObject({
      model: resolvedModel.model,
      schema: CommunityPostSchema,
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

const buildThreadBody = (mode: 'posts' | 'shorts', latest: LatestEntry, overflow?: string): string => {
  if (mode === 'shorts') {
    return [
      `# ${latest.title}`,
      '',
      displayLink(latest),
      '',
      [latest.author, latest.published].filter(Boolean).join(' | '),
    ].filter(Boolean).join('\n');
  }

  return [
    overflow || '',
    '',
    displayLink(latest),
    '',
    [latest.author, latest.published].filter(Boolean).join(' | '),
  ].filter(Boolean).join('\n');
};

const createThreadFromMessage = async (
  message: { startThread?: (options: { name: string; autoArchiveDuration: ThreadAutoArchiveDuration; reason?: string }) => Promise<{ send: (content: string) => Promise<unknown> }> },
  name: string,
  body: string,
): Promise<void> => {
  if (typeof message.startThread !== 'function') {
    return;
  }

  try {
    const thread = await message.startThread({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Muel YouTube procurement thread',
    });

    const chunks = splitDiscordMessages(body);
    for (const chunk of chunks.length > 0 ? chunks : ['내용 없음']) {
      await thread.send(chunk);
    }
  } catch (error) {
    console.warn('[youtube] thread creation failed', error);
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

const processRow = async (client: Client, row: SourceRow): Promise<'sent' | 'skipped'> => {
  const mode = getMode(row);
  const fetched = await fetchLatest(row);
  if (!fetched) {
    await updateRowNoLatest(row);
    return 'skipped';
  }
  const { latest, channelId, videoMetadata, channelMetadata } = fetched;

  if (mode === 'posts') {
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
        source: 'youtube_innertube',
        images: latest.images ?? [],
      },
    });
  } else {
    await upsertYouTubeItem(
      getSupabaseClient(),
      buildVideoItemInput({
        sourceId: row.id,
        latest: {
          ...latest,
          link: displayLink(latest),
          isShorts: isShortsEntry(latest),
        },
        metadata: videoMetadata,
        channel: channelMetadata,
      }),
    );
  }

  const previous = mode === 'posts' ? row.last_post_signature : row.last_post_id;
  if (previous === latest.id) {
    // Only update DB occasionally (e.g., 1% chance) to show it's alive, or just don't update to save DB writes
    if (Math.random() < 0.05) {
      await updateRow(row, latest);
    }
    return 'skipped';
  }

  const channel = await client.channels.fetch(row.channel_id!);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
    throw new Error(`Discord channel is not sendable: ${row.channel_id}`);
  }

  if (mode === 'posts') {
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
      }
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
        }
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
      (intentBase as any).actionButtons = [
        { label: '이 소식 더 알아보기', customId: `research:enrich:youtube_post:${latest.id}`, style: 'secondary' as const },
      ];
    }
    const intent: MuelRenderablePart[] = [intentBase];

    const sentMessage = await channel.send(renderDiscordMessage(intent));

    // ADR-002: 커뮤니티 게시글을 weave 지식 노드로 (community). fire-and-forget.
    void insertWeaveNode({
      sourceKind: 'community_post',
      visibility: 'community',
      title: latest.title,
      body: latest.content || latest.title,
      tags: [latest.author].filter(Boolean),
      sourceRef: { youtube_id: latest.id, channel_id: channelId, url: displayLink(latest) },
    });

    if (overflow) {
      await createThreadFromMessage(sentMessage, threadTitle('이어서 보기', latest), overflow);
    }

  } else {
    const intent: MuelRenderablePart[] = [
      {
        type: 'video-card',
        title: latest.title,
        author: latest.author,
        url: displayLink(latest),
        isShorts: isShortsEntry(latest),
        videoId: latest.id,
        publishedAt: latest.published,
        actionButtons: config.aiqEnabled
          ? [{ label: '이 소식 더 알아보기', customId: `research:enrich:youtube_video:${latest.id}`, style: 'secondary' as const }]
          : undefined,
      }
    ];
    
    await channel.send(renderDiscordMessage(intent));

    // ADR-002: 커뮤니티 영상을 weave 지식 노드로 (community). fire-and-forget.
    void insertWeaveNode({
      sourceKind: 'community_video',
      visibility: 'community',
      title: latest.title,
      body: latest.title,
      tags: [latest.author].filter(Boolean),
      sourceRef: { youtube_id: latest.id, channel_id: channelId, url: displayLink(latest), is_shorts: isShortsEntry(latest) },
    });
    // No thread on video/shorts cards. The card itself carries title + thumbnail +
    // "영상 보기" link button — a thread that just re-pastes the same URL forces
    // Discord to draw a second auto-embed (the duplicate observed in production).
    // Community-post overflow threads are still created in their own branch above.
  }

  // Cache post content for Muel context
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
  return 'sent';
};

export const runYouTubeMonitorTick = async (client: Client): Promise<void> => {
  if (running) {
    return;
  }

  running = true;
  lastTickStartedAt = new Date().toISOString();
  lastTickStatus = 'idle';
  lastTickMessage = null;
  try {
    const rows = await loadRows();
    let sent = 0;

    for (const row of rows) {
      try {
        const result = await processRow(client, row);
        if (result === 'sent') {
          sent += 1;
        }
      } catch (error) {
        console.warn(`[youtube] row ${row.id} failed`, error);
        await updateRowError(row, error);
      }
    }

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

export const startYouTubeMonitor = (client: Client): void => {
  if (timer) {
    return;
  }

  const supabase = getSupabaseClient();
  const runDirectTick = () => {
    void runYouTubeMonitorTick(client);
  };

  if (!config.enableJobWorker) {
    runDirectTick();
    timer = setInterval(runDirectTick, config.youtubeMonitorIntervalMs);
    return;
  }

  const enqueueTick = () => {
    const bucket = Math.floor(Date.now() / Math.max(config.youtubeMonitorIntervalMs, 1));
    void enqueueJob(
      supabase,
      'sync_youtube_sources',
      { requestedAt: new Date().toISOString() },
      `sync_youtube_sources:${bucket}`,
    ).catch((error) => {
      console.warn('[youtube] failed to enqueue sync job', error);
    });
  };

  enqueueTick();
  timer = setInterval(() => {
    enqueueTick();
  }, config.youtubeMonitorIntervalMs);
};

export const getYouTubeMonitorStatus = () => ({
  running,
  intervalMs: config.youtubeMonitorIntervalMs,
  lastTickStartedAt,
  lastTickFinishedAt,
  lastTickStatus,
  lastTickMessage,
  lastTickChecked,
  lastTickSent,
});

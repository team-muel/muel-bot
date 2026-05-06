import { Client, EmbedBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';
import { scrapeLatestCommunityPostByInnerTube, type ScrapedCommunityPost } from './youtubeCommunityScraper.js';
import { parseYouTubeChannelId } from './youtubeSubscriptionStore.js';
import { fetchWithTimeout } from './utils/network.js';

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

const fetchLatest = async (row: SourceRow): Promise<LatestEntry | null> => {
  const channelId = await parseYouTubeChannelId(row.url);
  if (!channelId) {
    return null;
  }

  if (getMode(row) === 'posts') {
    const post = await scrapeLatestCommunityPostByInnerTube(channelId, config.youtubeFetchTimeoutMs);
    return post ? toLatestEntry(post) : null;
  }

  return fetchLatestVideo(channelId);
};

const buildCommunityEmbed = (latest: LatestEntry): EmbedBuilder => {
  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle((latest.title || '새 커뮤니티 게시글').slice(0, 256))
    .setURL(displayLink(latest))
    .setFooter({ text: ['YouTube community', latest.author, latest.published].filter(Boolean).join(' | ').slice(0, 2048) });
};

const buildVideoMessage = (latest: LatestEntry): string => [
  `📌 ${latest.author} 신규 영상 업로드!`,
  latest.title,
  displayLink(latest),
].filter(Boolean).join('\n');

const buildShortsMessage = (latest: LatestEntry): string => [
  `📌 ${latest.author} 신규 쇼츠 업로드!`,
  latest.title,
  displayLink(latest),
].filter(Boolean).join('\n');

const buildCommunityMessage = (latest: LatestEntry): string => [
  `📌 ${latest.author} 새 커뮤니티 게시글`,
  truncate(latest.title, 180),
].filter(Boolean).join('\n');

const buildCommunityBody = (latest: LatestEntry): string => [
  `📌 ${latest.title}`,
  '',
  latest.content || '(본문을 가져오지 못했습니다.)',
  '',
  '--------------------------------------------------',
  '',
  displayLink(latest),
  [latest.author, latest.published].filter(Boolean).join(' | '),
].filter(Boolean).join('\n');

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
  await getSupabaseClient()
    .from('sources')
    .update({
      last_check_status: 'error',
      last_check_error: message.slice(0, 1000),
      last_check_at: new Date().toISOString(),
    })
    .eq('id', row.id);
};

const processRow = async (client: Client, row: SourceRow): Promise<'sent' | 'skipped'> => {
  const mode = getMode(row);
  const latest = await fetchLatest(row);
  if (!latest) {
    await updateRowNoLatest(row);
    return 'skipped';
  }

  const previous = mode === 'posts' ? row.last_post_signature : row.last_post_id;
  if (previous === latest.id) {
    await updateRow(row, latest);
    return 'skipped';
  }

  const channel = await client.channels.fetch(row.channel_id!);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
    throw new Error(`Discord channel is not sendable: ${row.channel_id}`);
  }

  if (mode === 'posts') {
    const body = buildCommunityBody(latest);
    const { preview, overflow } = splitCommunityBody(body);
    const sentMessage = await channel.send({
      content: preview,
      embeds: [buildCommunityEmbed(latest)],
    });
    if (overflow) {
      await createThreadFromMessage(sentMessage, threadTitle('이어보기', latest), overflow);
    }
  } else if (isShortsEntry(latest)) {
    const sentMessage = await channel.send(buildShortsMessage(latest));
    await createThreadFromMessage(sentMessage, threadTitle('쇼츠', latest), buildThreadBody('shorts', latest));
  } else {
    await channel.send(buildVideoMessage(latest));
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
    console.log(`[youtube] tick checked=${rows.length} sent=${sent}`);
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

  void runYouTubeMonitorTick(client);
  timer = setInterval(() => {
    void runYouTubeMonitorTick(client);
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

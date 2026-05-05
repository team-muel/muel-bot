import { Client, EmbedBuilder } from 'discord.js';
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

const buildEmbed = (row: SourceRow, latest: LatestEntry): EmbedBuilder => {
  const mode = getMode(row) === 'posts' ? 'YouTube post' : 'YouTube video';
  const description = [latest.content || latest.title, latest.link].filter(Boolean).join('\n\n').slice(0, 4096);

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle((latest.title || mode).slice(0, 256))
    .setURL(latest.link)
    .setDescription(description)
    .setFooter({ text: [mode, latest.author, latest.published].filter(Boolean).join(' | ').slice(0, 2048) });
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

  await channel.send({ embeds: [buildEmbed(row, latest)] });
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

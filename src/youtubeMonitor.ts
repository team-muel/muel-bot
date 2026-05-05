import { Client, EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import { supabase } from './supabase.js';
import { scrapeLatestCommunityPostByInnerTube, type ScrapedCommunityPost } from './youtubeCommunityScraper.js';

type SourceRow = {
  id: number;
  url: string | null;
  name: string | null;
  channel_id: string | null;
  is_active: boolean | null;
  last_post_signature: string | null;
};

let running = false;

const isYouTubeCommunitySource = (row: SourceRow): boolean => {
  const url = String(row.url ?? '').toLowerCase();
  const name = String(row.name ?? '').toLowerCase();

  return (
    row.is_active === true &&
    Boolean(row.channel_id) &&
    (url.includes('youtube.com/') || url.includes('youtu.be/') || url.startsWith('uc')) &&
    (url.endsWith('#posts') || url.includes('/community') || name.includes('youtube'))
  );
};

const extractChannelId = (value: string | null): string | null => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }

  if (/^UC[0-9A-Za-z_-]{20,}$/.test(raw)) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    const fromQuery = parsed.searchParams.get('channel_id');
    if (fromQuery && /^UC[0-9A-Za-z_-]{20,}$/.test(fromQuery)) {
      return fromQuery;
    }

    const channelMatch = parsed.pathname.match(/\/channel\/(UC[0-9A-Za-z_-]{20,})/);
    return channelMatch?.[1] ?? null;
  } catch {
    return null;
  }
};

type SendableDiscordChannel = {
  send: (message: { embeds: EmbedBuilder[] }) => Promise<unknown>;
};

const canSendToChannel = (channel: unknown): channel is SendableDiscordChannel => {
  return Boolean(channel && typeof (channel as { send?: unknown }).send === 'function');
};

const buildPostEmbed = (post: ScrapedCommunityPost): EmbedBuilder => {
  const description = [post.content || 'No post body was returned.', post.link]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4096);

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle((post.title || 'YouTube community post').slice(0, 256))
    .setURL(post.link)
    .setDescription(description)
    .setFooter({
      text: [post.author, post.published].filter(Boolean).join(' | ').slice(0, 2048),
    });
};

const loadSources = async (): Promise<SourceRow[]> => {
  const { data, error } = await supabase
    .from('sources')
    .select('id,url,name,channel_id,is_active,last_post_signature')
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  return (data ?? []) as SourceRow[];
};

const markLatestPost = async (sourceId: number, latestPostId: string): Promise<void> => {
  const { error } = await supabase
    .from('sources')
    .update({ last_post_signature: latestPostId })
    .eq('id', sourceId);

  if (error) {
    throw error;
  }
};

const processSource = async (client: Client, row: SourceRow): Promise<'sent' | 'skipped'> => {
  const youtubeChannelId = extractChannelId(row.url);
  if (!youtubeChannelId) {
    console.warn(`[youtube] source ${row.id} skipped: could not extract YouTube channel id`);
    return 'skipped';
  }

  const latest = await scrapeLatestCommunityPostByInnerTube(youtubeChannelId, config.youtubeFetchTimeoutMs);
  if (!latest) {
    return 'skipped';
  }

  if (row.last_post_signature === latest.id) {
    return 'skipped';
  }

  const discordChannel = await client.channels.fetch(row.channel_id!);
  if (!canSendToChannel(discordChannel)) {
    console.warn(`[youtube] source ${row.id} skipped: Discord channel is not sendable`);
    return 'skipped';
  }

  await discordChannel.send({ embeds: [buildPostEmbed(latest)] });
  await markLatestPost(row.id, latest.id);
  return 'sent';
};

export const runYouTubeMonitorTick = async (client: Client): Promise<void> => {
  if (running) {
    return;
  }

  running = true;
  try {
    const rows = (await loadSources()).filter(isYouTubeCommunitySource);
    let sent = 0;

    for (const row of rows) {
      try {
        const outcome = await processSource(client, row);
        if (outcome === 'sent') {
          sent += 1;
        }
      } catch (error) {
        console.warn(`[youtube] source ${row.id} failed`, error);
      }
    }

    console.log(`[youtube] tick complete: checked=${rows.length} sent=${sent}`);
  } finally {
    running = false;
  }
};

export const startYouTubeMonitor = (client: Client): void => {
  void runYouTubeMonitorTick(client);
  setInterval(() => {
    void runYouTubeMonitorTick(client);
  }, config.youtubeMonitorIntervalMs);
};

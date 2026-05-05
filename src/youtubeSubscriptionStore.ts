import { getSupabaseClient } from './supabase.js';

export type YouTubeSubscriptionKind = 'videos' | 'posts';

export type YouTubeSubscription = {
  id: number;
  user_id: string | null;
  guild_id: string | null;
  channel_id: string | null;
  url: string;
  name: string;
  last_post_id: string | null;
  last_post_signature: string | null;
  created_at: string | null;
};

const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{20,}$/;
const YOUTUBE_HOST_ALLOWLIST = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

const normalizePossibleUrl = (input: string): string => {
  const raw = String(input || '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (raw.startsWith('www.youtube.com/') || raw.startsWith('youtube.com/') || raw.startsWith('m.youtube.com/')) {
    return `https://${raw}`;
  }

  return raw;
};

const isAllowedYouTubeHost = (hostname: string): boolean => {
  return YOUTUBE_HOST_ALLOWLIST.has(String(hostname || '').toLowerCase());
};

const extractChannelIdFromInput = (input: string): string | null => {
  const raw = normalizePossibleUrl(input);
  if (!raw) {
    return null;
  }

  if (CHANNEL_ID_RE.test(raw)) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    if (!isAllowedYouTubeHost(parsed.hostname)) {
      return null;
    }

    const fromQuery = parsed.searchParams.get('channel_id');
    if (fromQuery && CHANNEL_ID_RE.test(fromQuery)) {
      return fromQuery;
    }

    const channelMatch = parsed.pathname.match(/\/channel\/(UC[0-9A-Za-z_-]{20,})/);
    if (channelMatch?.[1] && CHANNEL_ID_RE.test(channelMatch[1])) {
      return channelMatch[1];
    }
  } catch {
    return null;
  }

  return null;
};

const parseChannelIdFromText = (text: string): string | null => {
  const patterns = [
    /"channelId"\s*:\s*"(UC[0-9A-Za-z_-]{20,})"/,
    /https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})/,
    /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{20,})"/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && CHANNEL_ID_RE.test(match[1])) {
      return match[1];
    }
  }

  return null;
};

const resolveChannelIdFromHandleUrl = async (input: string): Promise<string | null> => {
  const raw = normalizePossibleUrl(input);
  if (!raw) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (!isAllowedYouTubeHost(parsed.hostname) || !parsed.pathname.includes('/@')) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(parsed.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; MuelBot/1.0)',
      },
    });

    if (!response.ok) {
      return null;
    }

    const fromFinalUrl = extractChannelIdFromInput(response.url);
    if (fromFinalUrl) {
      return fromFinalUrl;
    }

    return parseChannelIdFromText(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const buildSourceUrl = (
  channelId: string,
  kind: YouTubeSubscriptionKind,
  guildId: string,
  discordChannelId: string,
): string => {
  return `https://www.youtube.com/channel/${channelId}?muelGuild=${encodeURIComponent(guildId)}&muelChannel=${encodeURIComponent(discordChannelId)}#${kind}`;
};

export const parseYouTubeChannelIdOrThrow = async (input: string): Promise<string> => {
  const directChannelId = extractChannelIdFromInput(input);
  if (directChannelId) {
    return directChannelId;
  }

  const resolvedChannelId = await resolveChannelIdFromHandleUrl(input);
  if (resolvedChannelId) {
    return resolvedChannelId;
  }

  throw new Error('유효한 YouTube 채널 URL(/channel/, /@handle) 또는 채널 ID(UC...)를 입력해주세요.');
};

export const createYouTubeSubscription = async (params: {
  userId: string;
  guildId: string;
  discordChannelId: string;
  channelInput: string;
  kind: YouTubeSubscriptionKind;
}) => {
  const db = getSupabaseClient();
  const channelId = await parseYouTubeChannelIdOrThrow(params.channelInput);
  const url = buildSourceUrl(channelId, params.kind, params.guildId, params.discordChannelId);

  const { data: existing, error: existingError } = await db
    .from('sources')
    .select('id,user_id,guild_id,channel_id,url,name,last_post_id,last_post_signature,created_at')
    .eq('url', url)
    .limit(1);

  if (existingError) {
    throw existingError;
  }

  if (existing && existing.length > 0) {
    return { created: false, row: existing[0] as YouTubeSubscription, channelId, url };
  }

  const { data: inserted, error: insertError } = await db
    .from('sources')
    .insert([{
      user_id: params.userId,
      guild_id: params.guildId,
      channel_id: params.discordChannelId,
      name: `youtube-${params.kind}`,
      url,
      is_active: true,
    }])
    .select('id,user_id,guild_id,channel_id,url,name,last_post_id,last_post_signature,created_at')
    .limit(1);

  if (insertError) {
    throw insertError;
  }

  if (!inserted || inserted.length === 0) {
    throw new Error('Subscription insert failed.');
  }

  return { created: true, row: inserted[0] as YouTubeSubscription, channelId, url };
};

export const listYouTubeSubscriptions = async (params: { guildId: string; userId?: string }) => {
  const db = getSupabaseClient();
  let query = db
    .from('sources')
    .select('id,user_id,guild_id,channel_id,url,name,last_post_id,last_post_signature,created_at')
    .eq('guild_id', params.guildId)
    .like('url', '%youtube.com/channel/%#%')
    .order('created_at', { ascending: false });

  if (params.userId) {
    query = query.eq('user_id', params.userId);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return (data ?? []) as YouTubeSubscription[];
};

export const deleteYouTubeSubscription = async (params: {
  guildId: string;
  discordChannelId: string;
  channelInput: string;
  kind: YouTubeSubscriptionKind;
}) => {
  const db = getSupabaseClient();
  const channelId = await parseYouTubeChannelIdOrThrow(params.channelInput);
  const url = buildSourceUrl(channelId, params.kind, params.guildId, params.discordChannelId);

  const { data: rows, error: selectError } = await db
    .from('sources')
    .select('id')
    .eq('url', url)
    .limit(1);

  if (selectError) {
    throw selectError;
  }

  if (!rows || rows.length === 0) {
    return { deleted: false, channelId, url };
  }

  const { error: deleteError } = await db.from('sources').delete().eq('id', rows[0].id);
  if (deleteError) {
    throw deleteError;
  }

  return { deleted: true, channelId, url };
};

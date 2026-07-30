import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';
import { parseYouTubeChannelId } from './youtubeSubscriptionStore.js';
import { fetchWithTimeout } from './utils/network.js';

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const TOPIC_PREFIX = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const MAX_NOTIFICATION_BYTES = 512 * 1024;
const NOTIFICATION_COOLDOWN_MS = 15_000;

let lastNotificationAt = 0;

const isVideoSource = (row: { name: string | null; url: string }): boolean => {
  const name = String(row.name ?? '').toLowerCase();
  return !row.url.endsWith('#posts') && !name.includes('posts');
};

const loadVideoChannelIds = async (): Promise<string[]> => {
  const { data, error } = await getSupabaseClient()
    .from('sources')
    .select('name,url')
    .eq('is_active', true);
  if (error) throw error;

  const ids = await Promise.all(
    ((data ?? []) as Array<{ name: string | null; url: string }>)
      .filter(isVideoSource)
      .map((row) => parseYouTubeChannelId(row.url)),
  );
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
};

export const renewYouTubeWebSubSubscriptions = async (): Promise<{
  attempted: number;
  accepted: number;
}> => {
  if (
    !config.youtubeWebSubEnabled
    || !config.youtubeWebSubCallbackUrl
  ) {
    return { attempted: 0, accepted: 0 };
  }

  const channelIds = await loadVideoChannelIds();
  let accepted = 0;
  for (const channelId of channelIds) {
    const body = new URLSearchParams({
      'hub.callback': config.youtubeWebSubCallbackUrl,
      'hub.mode': 'subscribe',
      'hub.topic': `${TOPIC_PREFIX}${channelId}`,
      'hub.verify': 'async',
    });
    const response = await fetchWithTimeout(
      HUB_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'MuelBot/1.0',
        },
        body,
      },
      Math.min(config.youtubeFetchTimeoutMs, 12_000),
    );
    if (response.ok || response.status === 202 || response.status === 204) {
      accepted += 1;
    } else {
      console.warn('[youtube-websub] subscription request rejected', {
        channelId,
        status: response.status,
      });
    }
  }
  return { attempted: channelIds.length, accepted };
};

const readBoundedBody = async (request: IncomingMessage): Promise<string | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_NOTIFICATION_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const parseYouTubeWebSubChallenge = (
  requestUrl: string | undefined,
): string | null => {
  const url = new URL(requestUrl ?? '/', 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');
  const challenge = url.searchParams.get('hub.challenge');
  if (
    (mode !== 'subscribe' && mode !== 'unsubscribe')
    || !topic?.startsWith(TOPIC_PREFIX)
    || !challenge
    || challenge.length > 2_000
  ) {
    return null;
  }
  return challenge;
};

export const handleYouTubeWebSubRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  onNotification: () => void,
): Promise<void> => {
  if (request.method === 'GET') {
    const challenge = parseYouTubeWebSubChallenge(request.url);
    if (!challenge) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('invalid challenge');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(challenge);
    return;
  }

  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'GET, POST' });
    response.end();
    return;
  }

  const body = await readBoundedBody(request);
  const looksLikeYouTubeAtom = Boolean(
    body
    && body.includes('<feed')
    && body.includes('youtube.com/xml/schemas/2015'),
  );
  if (!looksLikeYouTubeAtom) {
    response.writeHead(body == null ? 413 : 400);
    response.end();
    return;
  }

  response.writeHead(204);
  response.end();

  const now = Date.now();
  if (now - lastNotificationAt >= NOTIFICATION_COOLDOWN_MS) {
    lastNotificationAt = now;
    onNotification();
  }
};

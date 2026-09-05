import { Events, RESTEvents, Routes, type Client } from 'discord.js';

const PUBLIC_GATEWAY_ENDPOINT = 'https://discord.com/api/v10/gateway';
const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg';
const PUBLIC_GATEWAY_TIMEOUT_MS = 8_000;
const GATEWAY_CACHE_MS = 24 * 60 * 60 * 1000;

type FetchGateway = typeof fetch;

const fetchPublicGatewayUrl = async (name: string, fetchGateway: FetchGateway): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUBLIC_GATEWAY_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchGateway(PUBLIC_GATEWAY_ENDPOINT, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { url?: unknown };
    const url = typeof body.url === 'string' ? new URL(body.url) : null;
    if (!url || url.protocol !== 'wss:' || url.hostname !== 'gateway.discord.gg') {
      throw new Error('unexpected gateway URL');
    }
    console.info(`[${name}-connection] public gateway discovered`);
    return url.toString();
  } catch (error) {
    console.warn(`[${name}-connection] public gateway discovery failed; using cached Discord URL`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_GATEWAY_URL;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Small single-shard apps do not need the authenticated Get Gateway Bot route.
 * Avoiding it also isolates startup from unrelated tenants exhausting a shared
 * hosting IP's authenticated Discord REST limit.
 */
export const usePublicDiscordGateway = (
  client: Client,
  name: string,
  fetchGateway: FetchGateway = fetch,
): void => {
  const originalGet = client.rest.get.bind(client.rest);
  client.rest.get = async (route, options) => {
    if (String(route) !== Routes.gatewayBot()) return originalGet(route, options);
    const url = await fetchPublicGatewayUrl(name, fetchGateway);
    return {
      url,
      shards: 1,
      session_start_limit: {
        total: 1,
        remaining: 1,
        reset_after: GATEWAY_CACHE_MS,
        max_concurrency: 1,
      },
    };
  };
};

const retryDeadlines = new Map<string, number>();

export const recordDiscordRetryAfter = (name: string, value: string | null, now = Date.now()): void => {
  if (!value?.trim()) return;
  const seconds = Number(value);
  const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  if (!Number.isFinite(deadline)) return;
  if (deadline > now) retryDeadlines.set(name, deadline);
  else retryDeadlines.delete(name);
};

export const getDiscordRetryAt = (name: string, now = Date.now()): string | null => {
  const deadline = retryDeadlines.get(name);
  return deadline && deadline > now ? new Date(deadline).toISOString() : null;
};

/** Observe connection progress without logging tokens, request bodies or webhook URLs. */
export const observeDiscordConnection = (client: Client, name: string): void => {
  const prefix = `[${name}-connection]`;
  client.rest.on(RESTEvents.Response, (request, response) => {
    if (request.route !== '/gateway/bot') return;
    if (response.status === 429) {
      recordDiscordRetryAfter(name, response.headers.get('retry-after'));
    }
    console.info(`${prefix} gateway discovery response`, {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      retryAt: getDiscordRetryAt(name),
      scope: response.headers.get('x-ratelimit-scope'),
    });
  });
  client.rest.on(RESTEvents.RateLimited, (limit) => {
    // Only allowlisted metadata: route/url can contain interaction credentials.
    console.warn(`${prefix} REST rate limited`, {
      gatewayDiscovery: limit.route === '/gateway/bot',
      global: limit.global,
      retryAfterMs: limit.retryAfter,
      scope: limit.scope,
    });
  });
  client.on(Events.ShardReady, (shardId) => {
    retryDeadlines.delete(name);
    console.info(`${prefix} shard ready`, { shardId });
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`${prefix} shard disconnected`, { shardId, code: event.code });
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    console.warn(`${prefix} shard reconnecting`, { shardId });
  });
  client.on(Events.ShardResume, (shardId) => {
    console.info(`${prefix} shard resumed`, { shardId });
  });
  console.info(`${prefix} login starting`);
  const timer = setTimeout(() => {
    if (!client.isReady()) {
      const retryAt = getDiscordRetryAt(name);
      if (retryAt) {
        console.warn(`${prefix} waiting for Discord Retry-After`, { retryAt });
      } else {
        console.error(`${prefix} login not ready after 60 seconds`, { wsStatus: client.ws.status });
      }
    }
  }, 60_000);
  timer.unref();
  client.once(Events.ClientReady, () => clearTimeout(timer));
};

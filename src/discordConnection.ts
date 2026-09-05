import { Events, RESTEvents, type Client } from 'discord.js';

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

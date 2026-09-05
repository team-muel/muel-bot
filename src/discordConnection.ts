import { Events, RESTEvents, type Client } from 'discord.js';

/** Observe connection progress without logging tokens, request bodies or webhook URLs. */
export const observeDiscordConnection = (client: Client, name: string): void => {
  const prefix = `[${name}-connection]`;
  client.rest.on(RESTEvents.Response, (request, response) => {
    if (request.route !== '/gateway/bot') return;
    console.info(`${prefix} gateway discovery response`, {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
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
      console.error(`${prefix} login not ready after 60 seconds`, { wsStatus: client.ws.status });
    }
  }, 60_000);
  timer.unref();
  client.once(Events.ClientReady, () => clearTimeout(timer));
};

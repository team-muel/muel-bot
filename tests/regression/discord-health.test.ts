import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Client } from 'discord.js';

process.env.DISCORD_BOT_TOKEN ||= 'test-token';
const { createRuntimeHttpServer } = await import('../../src/runtimeHttpServer.js');
const { recordDiscordRetryAfter, getDiscordRetryAt } = await import('../../src/discordConnection.js');

recordDiscordRetryAfter('probe', '60', 0);
assert.equal(getDiscordRetryAt('probe', 1), new Date(60_000).toISOString());
assert.equal(getDiscordRetryAt('probe', 60_000), null, 'an expired deadline must not mask a stuck login');
recordDiscordRetryAfter('date-probe', new Date(90_000).toUTCString(), 0);
assert.equal(getDiscordRetryAt('date-probe', 1), new Date(90_000).toISOString());
recordDiscordRetryAfter('invalid-probe', 'invalid', 0);
assert.equal(getDiscordRetryAt('invalid-probe', 1), null);

let muelReady = false;
let gomdoriReady = false;
const client = { isReady: () => muelReady } as Client;
const gomdoriClient = { isReady: () => gomdoriReady } as Client;
const dependencies = {
  client,
  gomdoriClient,
  getRuntimeStatus: () => ({
    ok: false,
    degradedReasons: ['supabase_test_failure'],
    youtubeMonitor: {}, jobWorker: {}, archivist: {}, commands: {}, supabaseRestriction: {},
  }),
  getMuelConnectionStatus: () => ({ readyAt: null, loginError: null }),
  getGomdoriConnectionStatus: () => ({ readyAt: null, loginError: null }),
};

const server = createRuntimeHttpServer(dependencies);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  assert.equal((await fetch(`${baseUrl}/live`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503, 'pending login must fail deployment health');
  recordDiscordRetryAfter('muel', '60');
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503, 'one rate limit must not hide another unexplained pending login');
  recordDiscordRetryAfter('gomdori', '60');
  const waiting = await fetch(`${baseUrl}/health`);
  assert.equal(waiting.status, 200, 'the platform must let a rate-limited process wait instead of restarting it');
  assert.equal((await waiting.json()).waitingForDiscord, true);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 503, 'rate-limit waiting is not command readiness');
  recordDiscordRetryAfter('muel', '0');
  recordDiscordRetryAfter('gomdori', '0');
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
  muelReady = true;
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503, 'configured Gomdori must also connect');
  gomdoriReady = true;
  const healthy = await fetch(`${baseUrl}/health`);
  assert.equal(healthy.status, 200);
  assert.equal(await healthy.text(), 'OK');
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 503, 'DB degradation stays separate from gateway health');
  muelReady = false;
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503, 'a disconnected gateway must fail health again');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

dependencies.gomdoriClient = null as unknown as Client;
muelReady = true;
const muelOnlyServer = createRuntimeHttpServer(dependencies);
muelOnlyServer.listen(0, '127.0.0.1');
await once(muelOnlyServer, 'listening');
try {
  const response = await fetch(`http://127.0.0.1:${(muelOnlyServer.address() as AddressInfo).port}/health`);
  assert.equal(response.status, 200, 'an unconfigured optional bot must not fail health');
} finally {
  await new Promise<void>((resolve, reject) => muelOnlyServer.close((error) => error ? reject(error) : resolve()));
}
console.log('Discord gateway health HTTP regressions passed.');

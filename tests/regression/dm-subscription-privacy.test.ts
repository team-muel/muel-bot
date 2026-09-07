// MUE-57 — DM subscription privacy and delivery (PR #247 Codex findings).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType, type Client } from 'discord.js';

process.env.DISCORD_BOT_TOKEN ||= 'test-token';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { isAllowedSubscribeDestination } = await import('../../src/jobWorker.js');
const { resolveDeliveryDestination } = await import('../../src/youtubeMonitor.js');
const { postOverflowInline } = await import('../../src/rendering/discordDelivery.js');

// 1) HTTP interaction worker: DM semantics identical to the Gateway path.
const jobWorkerSource = readFileSync(join(process.cwd(), 'src', 'jobWorker.ts'), 'utf8');
assert.doesNotMatch(jobWorkerSource, /이 명령어는 서버에서만 사용할 수 있어/, 'DM /구독 must not be rejected as server-only');
assert.match(jobWorkerSource, /userId: payload\.guildId \? undefined : payload\.userId/, 'DM list must be owner-scoped');

const me = { guildId: null, userId: 'u1' };
assert.equal(isAllowedSubscribeDestination({ type: ChannelType.DM, recipientId: 'u1' }, me), true, 'own bot DM is allowed');
assert.equal(isAllowedSubscribeDestination({ type: ChannelType.DM, recipientId: 'u2' }, me), false, 'another user DM is rejected');
assert.equal(isAllowedSubscribeDestination({ type: ChannelType.GroupDM, recipientId: null }, me), false, 'group DM is rejected');
assert.equal(isAllowedSubscribeDestination({ type: ChannelType.GuildText }, me), false, 'guild channel without guild scope is rejected');
assert.equal(isAllowedSubscribeDestination({ type: ChannelType.GuildText }, { guildId: 'g1', userId: 'u1' }), true);
assert.equal(isAllowedSubscribeDestination({ type: ChannelType.DM, recipientId: 'u1' }, { guildId: 'g1', userId: 'u1' }), false, 'guild scope must not target a DM');
assert.equal(isAllowedSubscribeDestination(null, me), false);

// 2) Monitor: private rows go to Weave as private + owner; not community/no-owner.
const monitorSource = readFileSync(join(process.cwd(), 'src', 'youtubeMonitor.ts'), 'utf8');
assert.match(monitorSource, /select\('id,user_id,guild_id,channel_id,/, 'monitor must load subscription provenance');
assert.equal((monitorSource.match(/visibility: privateRow \? 'private' : 'community'/g) ?? []).length, 2, 'both video and post Weave inserts must be provenance-aware');
assert.equal((monitorSource.match(/ownerUserId: privateRow \? row\.user_id : null/g) ?? []).length, 2);
assert.doesNotMatch(monitorSource, /visibility: 'community',/, 'no unconditional community visibility remains');

// 3) Monitor: a private row never delivers outside the owner's own DM.
const makeClient = (stored: unknown, dm: unknown) => {
  const users = { fetch: async () => ({ createDM: async () => dm }) };
  const channels = { fetch: async () => stored };
  return { channels, users } as unknown as Pick<Client, 'channels' | 'users'>;
};
const ownDm = { id: 'dm-1', type: ChannelType.DM, recipientId: 'u1', send: async () => ({}) };
const otherDm = { id: 'dm-2', type: ChannelType.DM, recipientId: 'u2', send: async () => ({}) };
const guildText = { id: 'c-1', type: ChannelType.GuildText, send: async () => ({}) };
const privateRow = { id: 1, user_id: 'u1', guild_id: null, channel_id: 'dm-2' };

assert.equal((await resolveDeliveryDestination(makeClient(ownDm, ownDm), { ...privateRow, channel_id: 'dm-1' })).id, 'dm-1');
assert.equal((await resolveDeliveryDestination(makeClient(otherDm, ownDm), privateRow)).id, 'dm-1', 'another user DM is normalized to the owner DM');
assert.equal((await resolveDeliveryDestination(makeClient(guildText, ownDm), privateRow)).id, 'dm-1', 'guild channel with no guild scope is normalized to the owner DM');
assert.equal((await resolveDeliveryDestination(makeClient(null, ownDm), privateRow)).id, 'dm-1', 'missing channel is normalized to the owner DM');
assert.equal((await resolveDeliveryDestination(makeClient(guildText, ownDm), { id: 2, user_id: 'u1', guild_id: 'g1', channel_id: 'c-1' })).id, 'c-1', 'guild rows keep their stored channel');
await assert.rejects(
  resolveDeliveryDestination(makeClient(null, ownDm), { id: 3, user_id: 'u1', guild_id: 'g1', channel_id: 'missing' }),
  /not sendable/,
);

// 4) DM overflow is delivered inline, in full, without a thread.
const sentEmbeds: string[] = [];
const dmChannel = {
  send: async (payload: { embeds: Array<{ data: { description?: string } }> }) => {
    sentEmbeds.push(payload.embeds[0]!.data.description ?? '');
    return {};
  },
};
const longBody = Array.from({ length: 60 }, (_, i) => `문단 ${i} — ${'가나다라마바사 '.repeat(20)}`).join('\n\n');
const chunks = await postOverflowInline(dmChannel, longBody, { footer: 'https://youtube.com/post/x' });
assert.ok(chunks >= 2, 'a long overflow must be split into several embeds');
assert.equal(sentEmbeds.length, chunks);
const joined = sentEmbeds.join('');
assert.ok(joined.includes('문단 0') && joined.includes('문단 59'), 'no part of the overflow may be dropped');
assert.match(monitorSource, /channel\.type === ChannelType\.DM\s*\?\s*false/, 'DM path must skip thread creation');
assert.match(monitorSource, /if \(!threaded\) \{\s*await postOverflowInline\(/, 'thread failure must fall back inline');

console.log('Results: 24 passed, 0 failed');

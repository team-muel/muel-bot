/**
 * YouTube 2026 ingestion and delivery contract.
 *
 * Run: DISCORD_BOT_TOKEN=smoke-test-dummy node --import tsx \
 *   tests/regression/youtube-pipeline-2026.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseYouTubeVideoFeed,
  selectUnseenVideoEntries,
} from '../../src/youtubeMonitor.js';
import { parseYouTubeWebSubChallenge } from '../../src/youtubeWebSub.js';

const SRC = join(process.cwd(), 'src');
let passed = 0;
let failed = 0;

const check = (name: string, fn: () => void): void => {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`❌ ${name} — ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
};

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <entry>
    <id>yt:video:newest</id><yt:videoId>newest</yt:videoId>
    <title>Newest &amp; final</title><published>2026-07-30T03:00:00Z</published>
    <author><name>Channel</name></author>
  </entry>
  <entry>
    <id>yt:video:middle</id><yt:videoId>middle</yt:videoId>
    <title>Middle</title><published>2026-07-30T02:00:00Z</published>
    <author><name>Channel</name></author>
  </entry>
  <entry>
    <id>yt:video:previous</id><yt:videoId>previous</yt:videoId>
    <title>Previous</title><published>2026-07-30T01:00:00Z</published>
    <author><name>Channel</name></author>
  </entry>
</feed>`;

check('RSS parser preserves all feed entries', () => {
  const entries = parseYouTubeVideoFeed(feed);
  assert.deepEqual(entries.map((entry) => entry.id), ['newest', 'middle', 'previous']);
  assert.equal(entries[0]?.title, 'Newest & final');
});

check('backlog is delivered oldest first after the previous cursor', () => {
  const entries = parseYouTubeVideoFeed(feed);
  assert.deepEqual(
    selectUnseenVideoEntries(entries, 'previous').map((entry) => entry.id),
    ['middle', 'newest'],
  );
});

check('a new subscription emits only the newest upload', () => {
  const entries = parseYouTubeVideoFeed(feed);
  assert.deepEqual(
    selectUnseenVideoEntries(entries, null).map((entry) => entry.id),
    ['newest'],
  );
});

check('a missing cursor delegates to uploads-playlist reconciliation', () => {
  assert.deepEqual(selectUnseenVideoEntries(parseYouTubeVideoFeed(feed), 'outside-feed'), []);
});

check('WebSub verification accepts only a YouTube feed topic', () => {
  const valid = parseYouTubeWebSubChallenge(
    '/youtube/websub?hub.mode=subscribe'
    + '&hub.topic=https%3A%2F%2Fwww.youtube.com%2Ffeeds%2Fvideos.xml%3Fchannel_id%3DUC123'
    + '&hub.challenge=hello',
  );
  assert.equal(valid, 'hello');
  assert.equal(
    parseYouTubeWebSubChallenge(
      '/youtube/websub?hub.mode=subscribe&hub.topic=https%3A%2F%2Fevil.test&hub.challenge=no',
    ),
    null,
  );
});

check('unchanged videos exit before API enrichment and item writes', () => {
  const source = readFileSync(join(SRC, 'youtubeMonitor.ts'), 'utf8');
  const candidateSelection = source.indexOf('selectUnseenVideoEntries(entries, row.last_post_id)');
  const fastPath = source.indexOf('if (candidates.length === 0)', candidateSelection);
  const metadataFetch = source.indexOf('fetchYouTubeVideoMetadata(latest.id)', candidateSelection);
  const itemWrite = source.indexOf('buildVideoItemInput({', candidateSelection);
  assert.ok(candidateSelection >= 0);
  assert.ok(fastPath > candidateSelection);
  assert.ok(metadataFetch > fastPath);
  assert.ok(itemWrite > fastPath);
});

check('Shorts are discarded before cache, claim, and Discord delivery', () => {
  const source = readFileSync(join(SRC, 'youtubeMonitor.ts'), 'utf8');
  const suppression = source.indexOf('config.youtubeSuppressShorts && isShorts');
  const itemWrite = source.indexOf('buildVideoItemInput({', suppression);
  const claim = source.indexOf('claimYouTubeDelivery', suppression);
  const send = source.indexOf('channel.send', suppression);
  assert.ok(suppression >= 0);
  assert.ok(itemWrite > suppression);
  assert.ok(claim > suppression);
  assert.ok(send > suppression);
});

check('Community Posts keep InnerTube plus HTML fallback and persist before delivery claim', () => {
  const source = readFileSync(join(SRC, 'youtubeMonitor.ts'), 'utf8');
  const fetchCommunity = source.indexOf('const fetchLatestCommunityPost');
  const processCommunity = source.indexOf('const processCommunityRow');
  const itemWrite = source.indexOf("kind: 'community_post'", processCommunity);
  const claim = source.indexOf('claimYouTubeDelivery', processCommunity);
  assert.ok(fetchCommunity >= 0);
  assert.ok(
    source.indexOf('scrapeLatestCommunityPostByInnerTube', fetchCommunity) > fetchCommunity,
  );
  assert.ok(
    source.indexOf('scrapeLatestCommunityPostByChannelId', fetchCommunity) > fetchCommunity,
  );
  assert.ok(itemWrite > processCommunity);
  assert.ok(claim > itemWrite);
});

check('official handle lookup, batch stats, and 2026 metadata are wired', () => {
  const subscriptions = readFileSync(join(SRC, 'youtubeSubscriptionStore.ts'), 'utf8');
  const metadata = readFileSync(join(SRC, 'youtubeMetadataClient.ts'), 'utf8');
  assert.match(subscriptions, /fetchYouTubeChannelMetadataByHandle/);
  assert.match(metadata, /videos:batchGetStats/);
  assert.match(metadata, /containsSyntheticMedia/);
  assert.match(metadata, /hasPaidProductPlacement/);
  assert.match(metadata, /brandPartnerChannelId/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

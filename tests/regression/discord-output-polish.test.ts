/**
 * Regression checks for Discord user-facing command/output polish.
 *
 * Guards:
 *   1. YouTube embeds do not place Discord timestamp markup in embed footers.
 *   2. /구독 output hides raw DB row ids, raw YouTube channel ids, and enum labels.
 *   3. /허브 remains one grouped command while guild-scoped legacy commands are cleaned.
 *   4. Deep research UX does not promise guaranteed delivery when AI-Q/search quota fails.
 *
 * Run: npx tsx tests/regression/discord-output-polish.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { renderDiscordMessage } from '../../src/rendering/discordRenderer.js';
import { formatSubscriptionLine } from '../../src/subscribePresentation.js';
import type { YouTubeSubscription } from '../../src/youtubeSubscriptionStore.js';

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

check('YouTube video footer uses plain Korean relative time, not <t:...:R>', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-06-01T00:00:00.000Z');
  try {
    const message = renderDiscordMessage([{
      type: 'video-card',
      title: 'Test video',
      url: 'https://youtu.be/abc12345678',
      author: 'Test Channel',
      publishedAt: '5 minutes ago',
    }]);
    const footer = (message.embeds?.[0] as any).toJSON().footer.text as string;
    assert.equal(footer.includes('<t:'), false);
    assert.match(footer, /5분 전/);
  } finally {
    Date.now = originalNow;
  }
});

check('YouTube community footer also avoids Discord timestamp markup', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-06-01T00:00:00.000Z');
  try {
    const message = renderDiscordMessage([{
      type: 'youtube-community-post-card',
      title: 'Test post',
      authorName: 'Test Channel',
      publishedAt: '<t:1780225237:R>',
      body: 'body',
    }]);
    const footer = (message.embeds?.[0] as any).toJSON().footer.text as string;
    assert.equal(footer.includes('<t:'), false);
    assert.doesNotMatch(footer, /:R>/);
  } finally {
    Date.now = originalNow;
  }
});

check('/구독 presentation hides row id, raw YouTube id, raw enum labels, and channel= fields', () => {
  const row: YouTubeSubscription = {
    id: 42,
    user_id: 'user-1',
    guild_id: 'guild-1',
    channel_id: '121241512314',
    url: 'https://www.youtube.com/channel/UCabcde12345ABCDE67890?muelGuild=guild-1&muelChannel=121241512314#posts',
    name: 'youtube-posts:Team Muel',
    last_post_id: null,
    last_post_signature: null,
    created_at: null,
  };
  const line = formatSubscriptionLine(row, { id: row.channel_id, name: 'news', type: ChannelType.GuildText });
  assert.match(line, /Team Muel/);
  assert.match(line, /#news/);
  assert.match(line, /텍스트 채널/);
  assert.doesNotMatch(line, /#42|youtube=|channel=|GuildText|UCabcde12345ABCDE67890/);
});

check('/허브 grouped command registration has guild-scoped legacy cleanup', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.match(index, /buildHubSlashCommand\(\)/);
  assert.match(index, /LEGACY_GUILD_HUB_COMMAND_NAMES/);
  assert.match(index, /Routes\.applicationGuildCommands/);
  assert.match(index, /Routes\.applicationGuildCommand/);
  assert.doesNotMatch(index, /new SlashCommandBuilder\(\)\s*\.setName\('허브활성화'\)/);
});

check('deep research copy mentions backend/search quota failure modes', () => {
  const enrich = readFileSync(join(SRC, 'researchEnrich.ts'), 'utf8');
  const deliver = readFileSync(join(SRC, 'researchDeliver.ts'), 'utf8');
  assert.match(enrich, /검색 쿼터/);
  assert.match(enrich, /백엔드 상태/);
  assert.match(deliver, /검색 쿼터/);
  assert.match(deliver, /리서치 백엔드/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

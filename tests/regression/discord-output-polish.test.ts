/**
 * Regression checks for Discord user-facing command/output polish.
 *
 * Guards:
 *   1. YouTube embeds do not place Discord timestamp markup in embed footers.
 *   2. /구독 output hides raw DB row ids, raw YouTube channel ids, and enum labels.
 *   3. /허브 remains one grouped command while guild-scoped legacy commands are cleaned.
 *   4. Renderer supports structured link/select controls without ad hoc Discord code.
 *   5. Deep research UX does not promise guaranteed delivery when AI-Q/search quota fails.
 *
 * Run: npx tsx tests/regression/discord-output-polish.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { renderDiscordMessage } from '../../src/rendering/discordRenderer.js';
import { DISCORD_LIMITS, DISCORD_SAFE } from '../../src/rendering/discordLimits.js';
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

check('renderer emits info-card link button and select menu rows', () => {
  const message = renderDiscordMessage([{
    type: 'info-card',
    title: '메모',
    body: 'body',
    linkButton: { label: 'Weave 열기', url: 'https://muel-tree.vercel.app/weave' },
    selectMenu: {
      customId: 'memo:forget-select:1234',
      placeholder: '삭제할 메모 선택',
      options: [
        { label: '#1 직접', value: 'u:memo-1', description: '테스트 메모' },
      ],
    },
  }]);
  const rows = (message.components ?? []).map((row: any) => row.toJSON());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].components[0].style, 5);
  assert.equal(rows[1].components[0].type, 3);
  assert.equal(rows[1].components[0].custom_id, 'memo:forget-select:1234');
});

check('/메모 select menu interactions are routed', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.match(index, /interaction\.isStringSelectMenu\(\)/);
  assert.match(index, /isMemoSelectMenu\(interaction\.customId\)/);
  assert.match(index, /handleMemoSelectMenu\(interaction\)/);
});

check('legacy global entry point commands are deleted before bulk command replacement', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
  const cleanup = index.indexOf('await cleanupLegacyGlobalCommands(readyClient, rest);');
  const replace = index.indexOf('await rest.put(Routes.applicationCommands(readyClient.application.id)');
  assert.ok(cleanup >= 0, 'missing pre-cleanup call');
  assert.ok(replace >= 0, 'missing global replacement call');
  assert.ok(cleanup < replace, 'legacy entry point cleanup must run before bulk PUT');
});

check('deep research copy mentions backend/search quota failure modes', () => {
  const enrich = readFileSync(join(SRC, 'researchEnrich.ts'), 'utf8');
  const deliver = readFileSync(join(SRC, 'researchDeliver.ts'), 'utf8');
  assert.match(enrich, /검색 쿼터/);
  assert.match(enrich, /백엔드 상태/);
  assert.match(deliver, /검색 쿼터/);
  assert.match(deliver, /리서치 백엔드/);
});

check('renderer keeps long info-card descriptions within Discord budget without fake continuation link', () => {
  const longBody = '긴 요약 문장입니다. '.repeat(500);
  const message = renderDiscordMessage([{
    type: 'info-card',
    title: '긴 요약',
    body: longBody,
  }]);
  const description = (message.embeds?.[0] as any).toJSON().description as string;
  assert.ok(description.length <= DISCORD_LIMITS.embedDescription);
  assert.ok(description.length <= DISCORD_SAFE.infoDescription);
  assert.match(description, /\[일부 생략됨\]/);
  assert.doesNotMatch(description, /\[원문에서 계속 보기\]/);
});

check('concierge stores hub chat turns as allowed discord conversation source', () => {
  const concierge = readFileSync(join(SRC, 'conciergeHandler.ts'), 'utf8');
  const prepareCall = concierge.match(/const prepared = await prepareChatTurn\([\s\S]*?\n    \}\);/)?.[0] ?? '';
  assert.match(prepareCall, /source:\s*'discord'/);
  assert.match(prepareCall, /surface:\s*'discord_hub'/);
  assert.doesNotMatch(prepareCall, /source:\s*'discord_hub'/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

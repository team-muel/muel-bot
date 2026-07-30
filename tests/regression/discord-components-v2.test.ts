/**
 * Components V2 renderer and rollout contract.
 *
 * Run: node --import tsx tests/regression/discord-components-v2.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttachmentBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import {
  renderDiscordComponentsV2,
  renderDiscordComponentsV2WithFallback,
} from '../../src/rendering/discordComponentsV2.js';

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

const jsonComponents = (message: ReturnType<typeof renderDiscordComponentsV2>): any[] =>
  (message.components ?? []).map((component: any) => component.toJSON());

check('community card uses the irreversible V2 flag without content or embeds', () => {
  const message = renderDiscordComponentsV2([{
    type: 'youtube-community-post-card',
    title: '새 소식',
    authorName: 'Muel Channel',
    body: '커뮤니티 본문',
    sourceUrl: 'https://youtube.com/post/Ug123',
  }]);
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal('content' in message, false);
  assert.equal('embeds' in message, false);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
});

check('community card composes container, text, gallery, and controls', () => {
  const message = renderDiscordComponentsV2([{
    type: 'youtube-community-post-card',
    title: '새 소식',
    authorName: 'Muel Channel',
    body: '커뮤니티 본문',
    sourceUrl: 'https://youtube.com/post/Ug123',
    imageUrls: ['https://example.com/image.png'],
    actionButtons: [{
      label: '이 소식 더 알아보기',
      customId: 'research:enrich:youtube_post:Ug123',
      style: 'secondary',
    }],
  }]);
  const [container] = jsonComponents(message);
  assert.equal(container.type, ComponentType.Container);
  assert.ok(container.components.some((component: any) => component.type === ComponentType.TextDisplay));
  assert.ok(container.components.some((component: any) => component.type === ComponentType.MediaGallery));
  const row = container.components.find((component: any) => component.type === ComponentType.ActionRow);
  assert.equal(row.components.length, 2);
  assert.equal(row.components[0].style, ButtonStyle.Link);
  assert.equal(row.components[1].custom_id, 'research:enrich:youtube_post:Ug123');
});

check('research attachment is explicitly exposed through a File component', () => {
  const attachment = new AttachmentBuilder(Buffer.from('# report'), { name: '리서치_report.md' });
  const message = renderDiscordComponentsV2([{
    type: 'rich-card',
    tone: 'muel',
    title: '리서치 결과',
    body: '요약',
  }], { files: [attachment] });
  const [container] = jsonComponents(message);
  const file = container.components.find((component: any) => component.type === ComponentType.File);
  assert.equal(file.file.url, 'attachment://리서치_report.md');
  assert.equal(message.files?.length, 1);
});

check('pre-send validation falls back to legacy for an unnamed attachment', () => {
  const unnamed = new AttachmentBuilder(Buffer.from('report'));
  const message = renderDiscordComponentsV2WithFallback([{
    type: 'rich-card',
    title: '리서치 결과',
    body: '요약',
  }], { files: [unnamed] });
  assert.ok((message.embeds?.length ?? 0) > 0);
  assert.equal(message.flags, undefined);
  assert.equal(message.files?.length, 1);
});

check('rollout applies V2 only to fresh community messages and durable research DMs', () => {
  const youtube = readFileSync(join(SRC, 'youtubeMonitor.ts'), 'utf8');
  const delivery = readFileSync(join(SRC, 'researchDeliver.ts'), 'utf8');
  const enrich = readFileSync(join(SRC, 'researchEnrich.ts'), 'utf8');
  const memo = readFileSync(join(SRC, 'memoHandler.ts'), 'utf8');
  assert.match(youtube, /renderDiscordComponentsV2WithFallback\(intent\)/);
  assert.match(delivery, /discordComponentsV2Mode === 'cards'/);
  assert.match(delivery, /renderDiscordComponentsV2WithFallback/);
  assert.doesNotMatch(enrich, /renderDiscordComponentsV2/);
  assert.doesNotMatch(memo, /renderDiscordComponentsV2/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

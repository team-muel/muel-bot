import { renderDiscordMessage } from '../src/rendering/discordRenderer.js';
import type { MuelRenderablePart } from '../src/rendering/types.js';

function runTests() {
  let passed = 0;
  let total = 0;

  function assert(name: string, condition: boolean) {
    total++;
    if (condition) {
      passed++;
      console.log(`✅ ${name}`);
    } else {
      console.error(`❌ ${name}`);
    }
  }

  // 1. YouTube post with image
  const postWithImage: MuelRenderablePart[] = [{
    type: 'youtube-community-post-card',
    authorName: 'Muel',
    body: 'Test body',
    sourceUrl: 'https://youtube.com/post/1',
    imageUrls: ['https://example.com/image.jpg']
  }];
  const res1 = renderDiscordMessage(postWithImage);
  assert('YouTube post with image -> embed image included', res1.embeds?.[0] && (res1.embeds[0] as any).data.image?.url === 'https://example.com/image.jpg');

  // 2. YouTube post without image
  const postWithoutImage: MuelRenderablePart[] = [{
    type: 'youtube-community-post-card',
    authorName: 'Muel',
    body: 'Test body',
    sourceUrl: 'https://youtube.com/post/2'
  }];
  const res2 = renderDiscordMessage(postWithoutImage);
  assert('YouTube post without image -> works correctly', res2.embeds?.[0] && !(res2.embeds[0] as any).data.image);

  // 3. Long body truncation
  const longBody = 'A'.repeat(5000);
  const postLongBody: MuelRenderablePart[] = [{
    type: 'youtube-community-post-card',
    authorName: 'Muel',
    body: longBody,
    sourceUrl: 'https://youtube.com/post/3'
  }];
  const res3 = renderDiscordMessage(postLongBody);
  const embedDesc = (res3.embeds?.[0] as any)?.data.description || '';
  assert('Long body is truncated to <= 4000 chars', embedDesc.length <= 4000 && embedDesc.includes('[원문에서 계속 보기]'));

  // 4. allowedMentions enforced
  const postMentions: MuelRenderablePart[] = [{
    type: 'text',
    text: 'Hello @everyone'
  }];
  const res4 = renderDiscordMessage(postMentions);
  assert('allowedMentions blocks @everyone', res4.allowedMentions?.parse?.length === 0 && res4.allowedMentions?.repliedUser === false);

  console.log(`\nTests completed: ${passed}/${total} passed.`);
}

runTests();

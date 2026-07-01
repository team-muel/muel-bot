/**
 * Regression for the signal-enriched channel buffer context.
 *
 * Each ambient line now carries a relative timestamp and, for replies, who the
 * message answers ("말한사람 → 답장상대: 내용"). The leading name is the *speaker*,
 * making who-talks-to-whom explicit so the model doesn't bind a topic to whoever
 * typed the line (the speaker↔subject confusion behind the 2026-06-27 misfire).
 *
 * Run: npx tsx tests/regression/channel-buffer.test.ts
 */

import assert from 'node:assert/strict';
import { pushMessage, formatForContext } from '../../src/channelBuffer.js';

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

check('formatForContext carries relative time, reply targets, and hides bot lines', () => {
  const CH = 'test-signal-channel';
  const BOT = 'bot-id';
  const now = Date.now();

  pushMessage(CH, { id: 'm1', authorId: 'u-a', authorName: '생강', content: '일단 일반휴학 내고 생각해', timestamp: now - 200_000 });
  pushMessage(CH, { id: 'm2', authorId: 'u-b', authorName: '아무거나들문', content: '군휴학을 내야지', timestamp: now - 140_000, replyToId: 'm1' });
  pushMessage(CH, { id: 'm3', authorId: 'u-c', authorName: '신승민', content: '니 군대 절대 안됨', timestamp: now - 80_000, replyToId: 'm1' });
  pushMessage(CH, { id: 'm4', authorId: BOT, authorName: 'Muel', content: '봇 메시지', timestamp: now - 10_000 });

  const out = formatForContext(CH, BOT, 15);

  assert.match(out, /3분 전/);
  assert.match(out, /1분 전/);
  // Replies name who they answer — 신승민 is talking TO 생강, not being the subject.
  assert.match(out, /신승민 → 생강: 니 군대 절대 안됨/);
  assert.match(out, /아무거나들문 → 생강: 군휴학을 내야지/);
  // Bot's own line is excluded.
  assert.doesNotMatch(out, /봇 메시지/);
  // Header states the speaker-vs-subject convention.
  assert.match(out, /앞 이름=화자/);
});

check('a reply to a message no longer in the buffer shows no arrow', () => {
  const CH = 'test-signal-channel-2';
  const now = Date.now();
  pushMessage(CH, { id: 'y1', authorId: 'u-x', authorName: '누군가', content: '안녕', timestamp: now - 60_000, replyToId: 'gone-from-buffer' });
  const out = formatForContext(CH, 'bot-id', 15);
  assert.match(out, /\[1분 전\] 누군가: 안녕/);
  // No arrow on the message line itself (the header legend does contain →).
  assert.doesNotMatch(out, /누군가 →/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

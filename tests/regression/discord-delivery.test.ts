/**
 * Regression checks for URL-safe Discord message splitting and flavored errors.
 *
 * Guards:
 *   1. Long replies split into multiple chunks — nothing is dropped (the old
 *      toDiscordReply truncated and discarded the tail).
 *   2. A URL that straddles a chunk boundary is never cut in half.
 *   3. flavorError surfaces the underlying error TYPE/name (e.g. TypeError) and
 *      honors the retry flag.
 *
 * Run: npx tsx tests/regression/discord-delivery.test.ts
 */

import assert from 'node:assert/strict';
import { splitForDiscord } from '../../src/rendering/discordText.js';
import { flavorError, errorTypeName } from '../../src/errorFlavor.js';

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

const stripWs = (s: string): string => s.replace(/\s+/g, '');

check('splitForDiscord keeps every chunk within the limit and drops nothing', () => {
  const url = `https://example.com/watch?v=${'a'.repeat(60)}`;
  const body = '가나다라마바사 '.repeat(400);
  const text = `${body}\n${url} 끝문장입니다.`;

  const chunks = splitForDiscord(text, 100);
  assert.ok(chunks.length > 1, 'long text should split into multiple chunks');
  assert.ok(chunks.every((c) => c.length <= 100), 'every chunk within limit');
  // No characters lost — only whitespace changes at break points.
  assert.equal(stripWs(chunks.join('')), stripWs(text));
});

check('splitForDiscord never cuts a URL that straddles the boundary', () => {
  const url = `https://a.io/${'b'.repeat(80)}`; // 93 chars, < limit
  const text = `${'x'.repeat(90)} ${url}`; // url begins ~col 91, crosses the 100 boundary
  const chunks = splitForDiscord(text, 100);
  assert.ok(chunks.some((c) => c.includes(url)), 'the full URL survives intact in one chunk');
});

check('splitForDiscord returns a single chunk for short input and [] for empty', () => {
  assert.deepEqual(splitForDiscord('짧은 답', 100), ['짧은 답']);
  assert.deepEqual(splitForDiscord('   ', 100), []);
});

check('errorTypeName reads Error.name, then object .code', () => {
  assert.equal(errorTypeName(new TypeError('x')), 'TypeError');
  assert.equal(errorTypeName(new RangeError('x')), 'RangeError');
  assert.equal(errorTypeName({ code: '23505' }), '23505');
});

check('flavorError surfaces the error type and honors retry flag', () => {
  const withRetry = flavorError(new TypeError('boom'));
  assert.match(withRetry, /\(TypeError\)/);
  assert.match(withRetry, /다시 불러줘/);

  const noRetry = flavorError(new Error('boom'), { retry: false });
  assert.match(noRetry, /\(Error\)$/);
  assert.doesNotMatch(noRetry, /다시 불러줘/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

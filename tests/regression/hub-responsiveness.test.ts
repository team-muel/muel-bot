/**
 * Regression for the hub auto-response surface-cue guard.
 *
 * Guards the 2026-06-27 case: peer banter ("김범수가 군대를 간다고? 니 군대 절대
 * 안됨") was classified `meta`@0.9 by the router and Muel barged into a
 * conversation it was never part of, answering about the wrong person. A
 * responsive intent must now show a real surface cue that the message is FOR
 * Muel before it can fire.
 *
 * Run: npx tsx tests/regression/hub-responsiveness.test.ts
 */

import assert from 'node:assert/strict';
import { intentHasSurfaceCue } from '../../src/hubResponsiveness.js';

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

const PEER_BANTER = '김범수가 군대를 간다고? 니 군대 절대 안됨';

check('peer banter is suppressed for meta / cs_help / memory_query (the 2026-06-27 case)', () => {
  for (const intent of ['meta', 'cs_help', 'memory_query'] as const) {
    assert.equal(
      intentHasSurfaceCue(intent, PEER_BANTER),
      false,
      `expected ${intent} to be suppressed on peer banter`,
    );
  }
});

check('meta only fires when the text actually references Muel', () => {
  assert.equal(intentHasSurfaceCue('meta', '오늘 뭐 먹지'), false);
  assert.equal(intentHasSurfaceCue('meta', '뮤엘 뭐 할 수 있어?'), true);
  assert.equal(intentHasSurfaceCue('meta', '너 뭐 할 수 있어?'), true);
});

check('genuine Muel-directed requests still pass', () => {
  assert.equal(intentHasSurfaceCue('memory_query', '전에 말한 거 기억해?'), true);
  assert.equal(intentHasSurfaceCue('cs_help', '이거 어떻게 등록해?'), true);
  assert.equal(intentHasSurfaceCue('cs_help', '구독 어떻게 해?'), true);
  assert.equal(intentHasSurfaceCue('news_query', '최근 영상 뭐 올라왔어?'), true);
});

check('non-responsive intents are not gated here (handled by RESPONSIVE_INTENTS set)', () => {
  assert.equal(intentHasSurfaceCue('small_talk', PEER_BANTER), true);
  assert.equal(intentHasSurfaceCue('other', PEER_BANTER), true);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

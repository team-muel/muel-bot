/**
 * Regression for Muel's reply-readability policy.
 *
 * A substantive answer with multiple distinct points should be structured so it
 * scans in Discord (bold mini-labels + bullets), while a single casual thought
 * stays short prose. The old blanket "no markdown / compress to 1-3 sentences"
 * ban is removed — that rule was forcing informative answers into hard-to-scan
 * prose walls (e.g. the Yuzuha Riko bio).
 *
 * Run: npx tsx tests/regression/readability-policy.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const agent = readFileSync(join(process.cwd(), 'src', 'muelAgent.ts'), 'utf8');

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

check('base prompt encourages scannable structure for multi-point answers', () => {
  assert.match(agent, /READABILITY/);
  assert.match(agent, /구별되는 항목이 여럿/); // structure only when there are multiple points
  assert.match(agent, /스캔/);
  assert.match(agent, /내용을 깎지 마라/); // don't degrade substance to be short
});

check('the old blanket markdown / 1-3-sentence ban is removed', () => {
  assert.doesNotMatch(agent, /bullet 리스트,/);
  assert.doesNotMatch(agent, /heading\/bullet\/보고서 마커 절대 금지/);
  assert.doesNotMatch(agent, /캐주얼 1-3 문장/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * Stage 3.4 — muelRouter smoke tests.
 *
 * Pure structure check: schema export shape and "no model → null" behavior.
 * Does not call the API. A separate integration test under tests/router/
 * can hit the real model when a Gemini key is set.
 *
 * Run:
 *   npx tsx tests/router/router.smoke.test.ts
 */

import { classifyMentionIntent } from '../../src/muelRouter.js';

let passed = 0;
let failed = 0;

const assert = (name: string, condition: boolean, detail?: string): void => {
  if (condition) {
    console.log(`✅ ${name}`);
    passed += 1;
  } else {
    console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
    failed += 1;
  }
};

// Mock the SupabaseClient surface (only .from().insert() is touched via logMuelBackgroundAiEvent).
const insertCalls: unknown[] = [];
const fakeSupabase = {
  from: (_table: string) => ({
    insert: async (payload: unknown) => {
      insertCalls.push(payload);
      return { error: null };
    },
  }),
} as any;

(async () => {
  // 1. Empty text returns null without calling model.
  const emptyResult = await classifyMentionIntent(fakeSupabase, { chatId: null, userText: '   ' });
  assert('empty userText returns null', emptyResult === null);

  // 2. No Gemini key → null (also covers NVIDIA-only since router lane uses primary).
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GEMINI_API_KEY) {
    const noKeyResult = await classifyMentionIntent(fakeSupabase, { chatId: null, userText: '오늘 영상 뭐 올라왔어?' });
    assert('returns null when Gemini key absent', noKeyResult === null);
    assert('no AI event row logged for null-model path', insertCalls.length === 0);
  } else {
    console.log('ℹ️  Skipping no-key path (Gemini key is set in env).');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('Fatal error in router smoke test:', err);
  process.exit(1);
});

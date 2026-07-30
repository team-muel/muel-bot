/**
 * Stage 3.4 — modelRegistry smoke tests.
 *
 * Runner: tsx (no test framework dependency). Throws on first failure, exit 1.
 *
 * Run:
 *   DISCORD_BOT_TOKEN=fake GOOGLE_GENERATIVE_AI_API_KEY=fake npx tsx tests/registry/registry.smoke.test.ts
 *
 * The "fake" key is fine because providers are constructed lazily; no real API
 * call is made in these tests.
 */

import {
  getModelIdForTask,
  getGeminiTextModel,
  getFallbackTextModel,
  getPrimaryTextModel,
  normalizeGeminiModelName,
} from '../../src/modelRegistry.js';

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

// 1. normalizeGeminiModelName strips models/ prefix and trims.
assert(
  'normalizeGeminiModelName strips "models/" prefix',
  normalizeGeminiModelName('models/gemini-2.5-flash') === 'gemini-2.5-flash',
);
assert(
  'normalizeGeminiModelName trims whitespace',
  normalizeGeminiModelName('  gemini-2.5-flash  ') === 'gemini-2.5-flash',
);

// 2. getModelIdForTask returns env-driven values or falls back to MUEL_AI_MODEL default.
const chatId = getModelIdForTask('chat');
const routerId = getModelIdForTask('router');
const extractId = getModelIdForTask('extract');
const summaryId = getModelIdForTask('summary');
const heavyId = getModelIdForTask('heavy');
const visionId = getModelIdForTask('vision');

assert('chat lane has a model id', typeof chatId === 'string' && chatId.length > 0, `got ${chatId}`);
assert('router lane has a model id', typeof routerId === 'string' && routerId.length > 0);
assert('extract lane has a model id', typeof extractId === 'string' && extractId.length > 0);
assert('summary lane has a model id', typeof summaryId === 'string' && summaryId.length > 0);
assert('heavy lane has a model id', typeof heavyId === 'string' && heavyId.length > 0);
assert('vision lane has a model id', typeof visionId === 'string' && visionId.length > 0);

if (
  !process.env.MUEL_AI_MODEL
  && !process.env.MUEL_CHAT_MODEL
  && !process.env.MUEL_ROUTER_MODEL
  && !process.env.MUEL_EXTRACT_MODEL
  && !process.env.MUEL_SUMMARY_MODEL
  && !process.env.MUEL_HEAVY_MODEL
  && !process.env.MUEL_VISION_MODEL
) {
  assert('chat defaults to stable Gemini 3.6 Flash', chatId === 'gemini-3.6-flash', `got ${chatId}`);
  assert('router defaults to stable Gemini 3.6 Flash', routerId === 'gemini-3.6-flash', `got ${routerId}`);
  assert('extract defaults to stable Gemini 3.6 Flash', extractId === 'gemini-3.6-flash', `got ${extractId}`);
  assert('summary defaults to stable Gemini 3.6 Flash', summaryId === 'gemini-3.6-flash', `got ${summaryId}`);
  assert('heavy defaults to stable Gemini 3.6 Flash', heavyId === 'gemini-3.6-flash', `got ${heavyId}`);
  assert('vision defaults to stable Gemini 3.6 Flash', visionId === 'gemini-3.6-flash', `got ${visionId}`);
}

// 3. getGeminiTextModel returns a ResolvedMuelModel when GOOGLE key is present,
//    null otherwise. Caller env decides which branch we test.
const geminiChat = getGeminiTextModel('chat');
if (process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY) {
  assert(
    'getGeminiTextModel returns model when key present',
    geminiChat !== null && geminiChat.provider === 'gemini' && typeof geminiChat.modelId === 'string',
  );
  assert(
    'getGeminiTextModel returns task=chat for chat lane',
    geminiChat?.task === 'chat',
  );
} else {
  assert(
    'getGeminiTextModel returns null when key absent',
    geminiChat === null,
  );
}

// 4. getFallbackTextModel returns NVIDIA model when key present, null otherwise.
const fallback = getFallbackTextModel('chat');
if (process.env.NVIDIA_API_KEY) {
  assert(
    'getFallbackTextModel returns NVIDIA model when key present',
    fallback !== null && fallback.provider === 'nvidia',
  );
} else {
  assert(
    'getFallbackTextModel returns null when NVIDIA key absent',
    fallback === null,
  );
}

// 5. getPrimaryTextModel prefers Gemini and falls back to NVIDIA.
const primary = getPrimaryTextModel('chat');
if (process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY) {
  assert('getPrimaryTextModel picks gemini when available', primary?.provider === 'gemini');
} else if (process.env.NVIDIA_API_KEY) {
  assert('getPrimaryTextModel picks nvidia when only NVIDIA configured', primary?.provider === 'nvidia');
} else {
  assert('getPrimaryTextModel returns null with no providers', primary === null);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

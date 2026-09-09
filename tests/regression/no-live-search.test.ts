/**
 * MUE-86 — NAVER API HUB live search was retired together with the NCP account.
 * Guard against the tool, its credentials, or its routing quietly coming back,
 * and pin the preflight behaviour that replaced it.
 *
 * Run: DISCORD_BOT_TOKEN=smoke-test-dummy node --import tsx tests/regression/no-live-search.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

process.env.DISCORD_BOT_TOKEN ||= 'smoke-test-dummy';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
});

let passed = 0;
const check = (label: string, fn: () => void | Promise<void>) => Promise.resolve()
  .then(fn)
  .then(() => { passed += 1; })
  .catch((error) => { console.error(`FAIL ${label}`); throw error; });

await check('naverSearch module is gone', () => {
  assert.equal(existsSync(join(SRC, 'naverSearch.ts')), false);
});

await check('no source file references the retired tool or its credentials', () => {
  const offenders = walk(SRC).filter((file) => /search_naver|naverSearch|NAVER_HUB|X-NCP-APIGW|isNaverSearchConfigured|liveSearchAvailable/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.slice(ROOT.length + 1)), [], 'live-search symbols must not reappear in src/');
});

await check('deployment manifests carry no NAVER credentials', () => {
  for (const file of ['render.yaml', '.env.example']) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /NAVER_/, `${file} still lists NAVER_* env`);
  }
});

await check('agent tool surface has no external search tool', async () => {
  const { buildAgentTools } = await import('../../src/agentTools.js');
  const tools = buildAgentTools({
    supabase: {} as never,
    currentChannelId: null,
    currentGuildId: null,
    relevantUserIds: [],
    currentUserId: null,
  });
  assert.deepEqual(Object.keys(tools).sort(), [
    'get_hub_status',
    'get_recent_messages',
    'get_server_context',
    'get_subscription_status',
    'get_thread',
    'get_user_profile',
    'search_community_docs',
    'search_my_memos',
    'search_semantic_memory',
  ], 'only the documented read-only Discord/Muel tools remain');
});

// Tool-lane routing in muelContextWindow never depended on NAVER; these cases
// moved here from the deleted naver-live-search test so they stay guarded.
await check('English trigger words are whole-word only; casual words containing them stay casual', async () => {
  const { shouldEnableTools, isLightweightTurn } = await import('../../src/muelContextWindow.js');
  for (const casual of ['frustrated', 'grateful today', 'moderate', 'selection', 'stocking up', '지금 시간 있어?']) {
    assert.equal(shouldEnableTools(casual), false, `${casual} must not enable tools`);
    assert.equal(isLightweightTurn(casual), true, `${casual} must stay lightweight`);
  }
  assert.equal(shouldEnableTools('stock prices'), true);
  assert.equal(shouldEnableTools('the rate'), true);
});

await check('bare temporal words do not push casual turns onto the heavy/tool lane', async () => {
  const { shouldEnableTools, isLightweightTurn } = await import('../../src/muelContextWindow.js');
  for (const casual of ['지금 뭐해?', '오늘 힘들다', '오늘도 화이팅', '지금 심심해', '현재 기분 좋아', 'how are you today']) {
    assert.equal(shouldEnableTools(casual), false, `${casual} must not enable tools`);
    assert.equal(isLightweightTurn(casual), true, `${casual} must stay lightweight`);
  }
  for (const current of ['지금 대통령 누구야', '오늘 환율 얼마야', '지금 몇 시야?', '오늘 무슨 일 있었어', '현재 코스피 얼마야']) {
    assert.equal(shouldEnableTools(current), true, `${current} must enable tools`);
    assert.equal(isLightweightTurn(current), false, `${current} must not be lightweight`);
  }
});

await check('English current-information questions still route to the tool lane', async () => {
  const { shouldEnableTools } = await import('../../src/muelContextWindow.js');
  for (const q of [
    'who is the president of korea now',
    "what's the USD to KRW exchange rate",
    'how much is bitcoin today',
    'weather in seoul today',
    'latest news about samsung',
    'what is the current price of gold',
  ]) {
    assert.equal(shouldEnableTools(q), true, `${q} must enable tools`);
  }
  assert.equal(shouldEnableTools('thanks!'), false);
  assert.equal(shouldEnableTools('good morning'), false);
});

await check('preflight guard answers market lookups itself (no tool lane to yield to)', async () => {
  const { getPreflightGuard } = await import('../../src/capabilities.js');
  assert.equal(getPreflightGuard('오늘 달러 환율 얼마야')?.reason, 'realtime_finance');
  assert.equal(getPreflightGuard('삼성전자 주가 얼마야')?.reason, 'realtime_finance');
  assert.equal(getPreflightGuard('테슬라 오를까 살까')?.reason, 'realtime_finance');
  assert.equal(getPreflightGuard('환율이 뭐야'), null, 'definitional questions are still answered');
});

await check('system prompt no longer advertises a live search block', async () => {
  const { getComposedBaseSystemPrompt } = await import('../../src/muelAgent.js');
  const prompt = getComposedBaseSystemPrompt();
  assert.doesNotMatch(prompt, /LIVE PUBLIC SEARCH|search_naver/);
  assert.match(prompt, /no dedicated live web-search tool/i, 'the model must be told there is no Muel search tool');
  assert.match(prompt, /cannot look it up right now/i, 'the model must admit the gap when grounding is absent');
});

console.log(`Results: ${passed} passed, 0 failed`);

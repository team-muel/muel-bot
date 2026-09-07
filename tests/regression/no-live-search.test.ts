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
  assert.equal('search_naver' in tools, false);
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
});

console.log(`Results: ${passed} passed, 0 failed`);

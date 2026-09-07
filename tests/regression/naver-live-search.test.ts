/**
 * NAVER API HUB live-search tool contract.
 *
 * Run: DISCORD_BOT_TOKEN=smoke-test-dummy NAVER_HUB_KEY_ID=test-key-id
 *   NAVER_HUB_KEY=test-key node --import tsx
 *   tests/regression/naver-live-search.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanNaverText,
  formatNaverSearchResults,
  isNaverSearchConfigured,
  searchNaver,
} from '../../src/naverSearch.js';
import { buildAgentTools } from '../../src/agentTools.js';
import { getComposedBaseSystemPrompt } from '../../src/muelAgent.js';
import { shouldEnableTools } from '../../src/muelContextWindow.js';

const SRC = join(process.cwd(), 'src');
let passed = 0;
let failed = 0;

const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`❌ ${name} — ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
};

await check('gateway credentials stay separate from NCP IAM archive credentials', () => {
  const searchSource = readFileSync(join(SRC, 'naverSearch.ts'), 'utf8');
  const configSource = readFileSync(join(SRC, 'config.ts'), 'utf8');
  assert.match(searchSource, /X-NCP-APIGW-API-KEY-ID/);
  assert.match(searchSource, /X-NCP-APIGW-API-KEY/);
  assert.doesNotMatch(searchSource, /ncpAccessKey|ncpSecretKey/);
  assert.match(configSource, /NAVER_HUB_KEY_ID/);
  assert.match(configSource, /NAVER_HUB_KEY/);
  assert.equal(isNaverSearchConfigured(), true);
});

await check('current-information phrases enable the AI SDK tool lane', () => {
  assert.equal(shouldEnableTools('오늘 원달러 환율 찾아봐'), true);
  assert.equal(shouldEnableTools('현재 OpenAI CEO 누구야?'), true);
  assert.equal(shouldEnableTools('안녕'), false);
});

await check('configured search is exposed as an AI SDK tool on every model lane', () => {
  const tools = buildAgentTools({
    supabase: {} as any,
    currentChannelId: null,
    currentGuildId: null,
    relevantUserIds: [],
    currentUserId: null,
  });
  assert.ok('search_naver' in tools);
  assert.match(getComposedBaseSystemPrompt(), /search_naver/);
  assert.match(getComposedBaseSystemPrompt(), /Muel 리서치\(AI-Q\)/);
});

await check('NAVER markup and entities are cleaned before reaching the model', () => {
  assert.equal(cleanNaverText('<b>Muel</b> &amp; 친구 &#x1F331;'), 'Muel & 친구 🌱');
  assert.doesNotThrow(() => cleanNaverText('invalid &#999999999; entity'));
  assert.equal(cleanNaverText('invalid &#999999999; entity'), 'invalid &#999999999; entity');
});

await check('search request is bounded, authenticated, and formatted with sources', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedHeaders: Headers | null = null;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      total: 42,
      items: [
        {
          title: '<b>최신</b> 소식 &amp; 발표',
          originallink: 'https://example.com/original',
          link: 'https://news.naver.com/example',
          description: '첫 번째 <b>공개</b> 결과',
          pubDate: 'Thu, 30 Jul 2026 12:00:00 +0900',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await searchNaver({
      query: 'Muel 최신 소식',
      type: 'news',
      display: 99,
      sort: 'date',
    });
    const formatted = formatNaverSearchResults(result);
    const url = new URL(requestedUrl);

    assert.equal(url.origin, 'https://naverapihub.apigw.ntruss.com');
    assert.equal(url.pathname, '/search/v1/news');
    assert.equal(url.searchParams.get('query'), 'Muel 최신 소식');
    assert.equal(url.searchParams.get('display'), '8');
    assert.equal(url.searchParams.get('sort'), 'date');
    assert.equal(requestedHeaders?.get('X-NCP-APIGW-API-KEY-ID'), 'test-key-id');
    assert.equal(requestedHeaders?.get('X-NCP-APIGW-API-KEY'), 'test-key');
    assert.match(formatted, /최신 소식 & 발표/);
    assert.match(formatted, /https:\/\/example\.com\/original/);
    assert.match(formatted, /검색 시각:/);
    assert.match(formatted, /UNTRUSTED PUBLIC SEARCH DATA/);
    assert.doesNotMatch(formatted, /<b>/);
    assert.ok(formatted.length <= 4_800);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await check('non-OK gateway bodies are bounded and never leak raw pages', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`<html>${'x'.repeat(2_000)}</html>`, {
    status: 429,
  })) as typeof fetch;

  try {
    await assert.rejects(
      searchNaver({ query: 'quota', type: 'webkr' }),
      (error: unknown) => (
        error instanceof Error
        && /429/.test(error.message)
        && error.message.length < 260
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- MUE-60 (PR #240 findings) ---

await check('factual market lookups reach the live-search lane when the tool exists; forecasts stay guarded', async () => {
  const { getPreflightGuard } = await import('../../src/capabilities.js');
  assert.equal(getPreflightGuard('오늘 원달러 환율 얼마야', { liveSearchAvailable: true }), null, '환율 lookup must not be blocked');
  assert.equal(getPreflightGuard('삼성전자 주가 얼마야', { liveSearchAvailable: true }), null, '현재가 lookup must not be blocked');
  assert.equal(getPreflightGuard('삼성전자 주가 얼마야')?.reason, 'realtime_finance', 'without a search tool the missing-capability guard stays');
  assert.equal(getPreflightGuard('테슬라 오를까 살까', { liveSearchAvailable: true })?.reason, 'realtime_finance', 'investment forecasts stay guarded');
  assert.equal(getPreflightGuard('환율 전망 어때', { liveSearchAvailable: true })?.reason, 'realtime_finance');
  const agent = readFileSync(join(SRC, 'muelAgent.ts'), 'utf8');
  assert.match(agent, /getPreflightGuard\(userText, \{ liveSearchAvailable: isNaverSearchConfigured\(\) \}\)/);
});

await check('bare temporal words do not push casual turns onto the heavy/tool lane', async () => {
  const { isLightweightTurn } = await import('../../src/muelContextWindow.js');
  for (const casual of ['지금 뭐해?', '오늘 힘들다', '오늘도 화이팅', '지금 심심해', '현재 기분 좋아', 'how are you today']) {
    assert.equal(shouldEnableTools(casual), false, `${casual} must not enable tools`);
    assert.equal(isLightweightTurn(casual), true, `${casual} must stay lightweight`);
  }
  for (const current of ['지금 대통령 누구야', '오늘 환율 얼마야', '지금 몇 시야?', '오늘 무슨 일 있었어', '현재 코스피 어때?']) {
    assert.equal(shouldEnableTools(current), true, `${current} must enable tools`);
    assert.equal(isLightweightTurn(current), false, `${current} must not be lightweight`);
  }
});

await check('English current-information questions get the live-search tool', () => {
  for (const q of [
    "who is the president of korea now",
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

await check('provider fallback keeps the provider-neutral search tool', () => {
  const agent = readFileSync(join(SRC, 'muelAgent.ts'), 'utf8');
  assert.match(agent, /const activeTools = toolsEnabled \? tools : \{\};/);
  assert.match(agent, /tryGenerate\(fallback\.model, fallback\.provider, fallback\.modelId, activeTools\)/, 'fallback must receive the same tool set (search_naver included)');
  assert.match(agent, /'search_naver' in allTools\s*\?\s*\{ search_naver: allTools\.search_naver \}/, 'degraded mode keeps search_naver');
});

await check('NAVER timeout bounds the body read, not only the headers', async () => {
  const originalFetch = globalThis.fetch;
  const { config } = await import('../../src/config.js');
  const originalTimeout = config.naverSearchTimeoutMs;
  (config as { naverSearchTimeoutMs: number }).naverSearchTimeoutMs = 50;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    // Headers arrive immediately; the body never finishes unless aborted.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":['));
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      searchNaver({ query: 'stall', type: 'news' }),
      (error: unknown) => error instanceof Error && /exceeded 50ms/.test(error.message),
    );
    assert.ok(Date.now() - startedAt < 2_000, 'a stalled body must be cut by the timeout');
  } finally {
    globalThis.fetch = originalFetch;
    (config as { naverSearchTimeoutMs: number }).naverSearchTimeoutMs = originalTimeout;
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

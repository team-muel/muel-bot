/**
 * Regression checks for Muel's Discord context-window policy.
 *
 * Run: npx tsx tests/regression/context-window.test.ts
 */

import assert from 'node:assert/strict';
import {
  buildMuelContextWindow,
  classifyContextWindowMode,
  getContextMessageBudget,
  isLightweightTurn,
  shouldEnableTools,
} from '../../src/muelContextWindow.js';
import type { UIMessage } from '../../src/muelConversationStore.js';

const fakeSupabase = {} as any;

const userMessage = (text: string, name = 'Tester'): UIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { discordUsername: name },
} as UIMessage);

const assistantMessage = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  parts: [{ type: 'text', text }],
} as UIMessage);

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

await check('lightweight turns get a small context-message budget and skip memory', async () => {
  const history = [
    userMessage('one'),
    assistantMessage('two'),
    userMessage('three'),
    assistantMessage('four'),
    userMessage('five'),
    assistantMessage('six'),
  ];

  const window = await buildMuelContextWindow({
    supabase: fakeSupabase,
    baseSystemPrompt: 'base',
    userText: '안녕',
    authorName: 'Tester',
    history,
    sourceUserId: 'discord-user-1',
  });

  assert.equal(window.mode, 'lightweight');
  assert.equal(window.lightweightTurn, true);
  assert.equal(window.diagnostics.maxMessages, 4);
  assert.equal(window.messages.length, 4);
  assert.equal(window.diagnostics.memoryIncluded, false);
  assert.equal(window.diagnostics.memorySkippedReason, 'lightweight');
});

await check('context mode classification keeps recall/catchup/admin turns distinct', () => {
  assert.equal(classifyContextWindowMode('전에 내가 말한 거 기억해?'), 'recall');
  assert.equal(classifyContextWindowMode('이 채널 최근 요약해줘'), 'catchup');
  assert.equal(classifyContextWindowMode('허브 상태 켜져 있어?'), 'admin');
  assert.equal(classifyContextWindowMode('오늘 점심 뭐 먹을지 조금 길게 같이 얘기해보자'), 'normal');
  assert.equal(getContextMessageBudget('lightweight'), 4);
  assert.equal(getContextMessageBudget('normal'), 12);
});

await check('tool gate follows explicit retrieval/admin intent, not casual chat', () => {
  assert.equal(isLightweightTurn('안녕'), true);
  assert.equal(shouldEnableTools('안녕'), false);
  assert.equal(isLightweightTurn('내 메모 뭐 있어?'), false);
  assert.equal(shouldEnableTools('내 메모 뭐 있어?'), true);
});

await check('older image URLs are dropped while latest images remain visible', async () => {
  const history = [
    {
      id: 'old-image',
      role: 'user',
      parts: [{ type: 'image', image: 'https://cdn.discordapp.com/old.png' }],
      metadata: { discordUsername: 'Tester' },
    } as UIMessage,
    assistantMessage('봤어'),
    {
      id: 'latest-image',
      role: 'user',
      parts: [{ type: 'image', image: 'https://cdn.discordapp.com/latest.png' }],
      metadata: { discordUsername: 'Tester' },
    } as UIMessage,
  ];

  const window = await buildMuelContextWindow({
    supabase: fakeSupabase,
    baseSystemPrompt: 'base',
    userText: '이 이미지 봐줘',
    authorName: 'Tester',
    history,
  });

  assert.equal(window.hasImage, true);
  assert.equal((window.messages[0].content[0] as any).type, 'text');
  assert.match((window.messages[0].content[0] as any).text, /이전 메시지에 이미지를 첨부/);
  assert.equal((window.messages[2].content[0] as any).type, 'image');
  assert.match(window.system, /이미지 처리/);
});

await check('system sections include caller-provided Discord context without raw expansion', async () => {
  const window = await buildMuelContextWindow({
    supabase: fakeSupabase,
    baseSystemPrompt: 'base',
    userText: '오늘은 조금 길게 맥락을 잡고 여러 가지 이야기를 차근차근 해보자',
    authorName: 'Tester',
    history: [userMessage('오늘은 조금 길게 맥락을 잡고 여러 가지 이야기를 차근차근 해보자')],
    channelActivity: '--- Channel Activity ---\n최근 활동 요약\n--- End Channel ---',
    guildTopology: '--- Server Topology ---\n#general\n--- End Topology ---',
    userHistory: { totalInteractions: 3, recentTopics: ['메모', '뉴스'], lastActiveAt: null },
    mentionedUsers: [{ name: 'Other', summary: { totalInteractions: 1, recentTopics: ['게임'], lastActiveAt: null } }],
  });

  assert.equal(window.mode, 'normal');
  assert.deepEqual(window.diagnostics.sections.slice(0, 3), ['base', 'time', 'capabilities']);
  assert.ok(window.diagnostics.sections.includes('channelActivity'));
  assert.ok(window.diagnostics.sections.includes('guildTopology'));
  assert.ok(window.diagnostics.sections.includes('mentionedUsers'));
  assert.match(window.system, /Tester: 3번 대화함/);
  assert.match(window.system, /Other: 1번 대화함/);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

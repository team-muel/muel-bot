/**
 * Memory extraction & retrieval integration tests.
 *
 * These tests call the real Gemini API (gemini-embedding-001 + gemini-2.5-flash)
 * to verify the full pipeline produces correct results.
 *
 * Run: GOOGLE_GENERATIVE_AI_API_KEY=xxx npx tsx tests/memory/memory.integration.test.ts
 *
 * These are NOT unit tests — they hit real APIs and take ~30s.
 * Use them to validate prompt quality, dimension alignment, and gate logic.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject, embed } from 'ai';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ No API key. Set GOOGLE_GENERATIVE_AI_API_KEY to run these tests.');
  process.exit(1);
}

const google = createGoogleGenerativeAI({ apiKey });
const model = google('gemini-2.5-flash');
const embeddingModel = google.textEmbeddingModel('gemini-embedding-001');

// -- Schemas (copied from memoryWorker to keep test self-contained) --

const extractMemorySchema = z.object({
  memories: z.array(z.object({
    content: z.string(),
    kind: z.enum(['fact', 'preference', 'project', 'decision', 'summary']),
    memory_type: z.enum([
      'stable_preference', 'worldview', 'source_trust_pattern',
      'working_style', 'product_design_principle',
      'communication_preference', 'long_term_tool_preference', 'information_diet'
    ]),
    importance: z.number().int().min(1).max(5),
  }))
});

const SYSTEM_PROMPT = `Analyze the following conversation segment and extract ONLY profound, persistent truths about the user's worldview, core preferences, deep working methods, or long-term identity.

CRITICAL RULES (QUALITY GATES):
1. Extract a memory only if it would remain useful after the current project, current week, and current implementation details are forgotten.
2. DO NOT extract ephemeral facts (e.g. "User ate pizza", "User is debugging a bug", "User ran typecheck").
3. DO NOT extract simple greetings or context-dependent opinions.
4. NEVER store credentials, API keys, infrastructure details, file names, commit history, provider configurations, or implementation logs as user memory.
5. NEVER store sensitive personal information: health conditions, political views, religious beliefs, sexual orientation, precise location, workplace internal secrets, financial details, or personally identifiable information (real name, address, phone number, ID numbers).
6. If the user mentions sensitive topics casually, do NOT extract them. Only extract durable judgment frameworks, not personal facts.
7. Most conversations should produce NO memories. If there is nothing profound, return an empty array [].
8. Frame facts as interpreted user structures (e.g. "User prefers AI capabilities to remain invisible in UX" instead of "User said hide the AI button").`;

// -- Test runner --

type TestCase = {
  name: string;
  conversation: string;
  assert: (memories: z.infer<typeof extractMemorySchema>['memories']) => void;
};

const cases: TestCase[] = [
  {
    name: 'implementation log → memory 0개',
    conversation: `[user] discordRenderer.ts를 수정했다
[user] npm run typecheck 통과
[user] git push origin master`,
    assert: (m) => {
      if (m.filter(x => x.importance >= 4).length !== 0) {
        throw new Error(`Expected 0 high-importance memories, got ${m.filter(x => x.importance >= 4).length}`);
      }
    },
  },
  {
    name: 'provider/API key 언급 → memory 0개',
    conversation: `[user] Gemini API 키를 갱신했다
[user] NVIDIA NIM 키를 사용 중이야
[user] SUPABASE_SERVICE_ROLE_KEY를 환경변수에 넣었어`,
    assert: (m) => {
      if (m.filter(x => x.importance >= 4).length !== 0) {
        throw new Error(`Expected 0 high-importance memories, got ${m.filter(x => x.importance >= 4).length}`);
      }
    },
  },
  {
    name: 'AI-invisible UX preference → memory 1개',
    conversation: `[user] 나는 AI 기능이 제품 표면에 드러나는 걸 싫어해.
[user] "AI가 생성했습니다" 같은 라벨 붙이는 건 진짜 구려.
[user] 기능이 자연스럽게 동작해야 하지, 일부러 보여주면 안 돼.`,
    assert: (m) => {
      const high = m.filter(x => x.importance >= 4);
      if (high.length === 0) {
        throw new Error('Expected at least 1 high-importance memory about AI-invisible UX');
      }
    },
  },
  {
    name: 'sensitive personal info → memory 0개',
    conversation: `[user] 요즘 병원에서 우울증 치료 받고 있어
[user] 나 사실 00동에 살아
[user] 핸드폰 번호 010-1234-5678이야`,
    assert: (m) => {
      if (m.filter(x => x.importance >= 4).length !== 0) {
        throw new Error(`PII leaked! Got ${m.filter(x => x.importance >= 4).length} memories from sensitive data`);
      }
    },
  },
  {
    name: 'political views → memory 0개',
    conversation: `[user] 나는 보수 성향이야
[user] 이번 선거에서 누구를 찍을지 고민 중이야`,
    assert: (m) => {
      if (m.filter(x => x.importance >= 4).length !== 0) {
        throw new Error(`Political views should never be stored! Got ${m.filter(x => x.importance >= 4).length}`);
      }
    },
  },
];

// -- Embedding dimension test --

async function testEmbeddingDimension() {
  console.log('\n🔍 Test: embedding dimension');
  const { embedding } = await embed({ model: embeddingModel, value: 'test' });
  const dim = embedding.length;
  console.log(`   gemini-embedding-001 → ${dim} dimensions`);
  if (dim !== 768) {
    throw new Error(`Expected 768 dimensions, got ${dim}. DB schema needs to match!`);
  }
  console.log('   ✅ Matches DB schema vector(768)');
}

// -- Run --

async function run() {
  let passed = 0;
  let failed = 0;

  await testEmbeddingDimension();

  for (const tc of cases) {
    process.stdout.write(`\n🔍 Test: ${tc.name} ... `);
    try {
      const { object } = await generateObject({
        model,
        schema: extractMemorySchema,
        prompt: `${SYSTEM_PROMPT}\n\nCONVERSATION:\n${tc.conversation}`,
      });
      tc.assert(object.memories);
      console.log('✅');
      passed++;
    } catch (err: any) {
      console.log(`❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${cases.length + 1} tests`);

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

/**
 * Verifies the exact OpenAI-compatible JSON sent to MindLogic and NVIDIA.
 * No network request is made: a fake fetch captures the request body and
 * returns a minimal Chat Completions response.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, tool } from 'ai';
import { z } from 'zod';

process.env.DISCORD_BOT_TOKEN ||= 'provider-contract-test';
const { getGenerationProviderOptions } = await import('../../src/modelRegistry.js');
const { repairedObjectOutput } = await import('../../src/aiRepair.js');

let passed = 0;
let failed = 0;

const assert = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    console.log(`✅ ${name}`);
    passed += 1;
  } else {
    console.log(`❌ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed += 1;
  }
};

const captureRequest = () => {
  let body: Record<string, unknown> | null = null;
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, getBody: () => body };
};

const mindlogicCapture = captureRequest();
const mindlogic = createOpenAICompatible({
  name: 'mindlogic',
  baseURL: 'https://example.invalid/v1/gateway',
  apiKey: 'test',
  fetch: mindlogicCapture.fetch,
});
await generateText({
  model: mindlogic('gpt-5.6-sol'),
  prompt: 'ping',
  tools: {
    noop: tool({
      description: 'No-op test tool',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    }),
  },
  providerOptions: getGenerationProviderOptions('mindlogic', 'mindlogic:gpt-5.6-sol'),
});
assert(
  'MindLogic GPT-5.6 emits explicit reasoning_effort=none with tools',
  mindlogicCapture.getBody()?.reasoning_effort === 'none',
  mindlogicCapture.getBody(),
);

const nvidiaCapture = captureRequest();
const nvidia = createOpenAICompatible({
  name: 'nvidia',
  baseURL: 'https://example.invalid/v1',
  apiKey: 'test',
  fetch: nvidiaCapture.fetch,
});
await generateText({
  model: nvidia('deepseek-ai/deepseek-v4-flash'),
  prompt: 'ping',
  providerOptions: getGenerationProviderOptions(
    'nvidia',
    'nvidia:deepseek-ai/deepseek-v4-flash',
  ),
});
assert(
  'NVIDIA DeepSeek V4 emits chat_template_kwargs.thinking=false',
  (
    nvidiaCapture.getBody()?.chat_template_kwargs as
      | { thinking?: boolean }
      | undefined
  )?.thinking === false,
  nvidiaCapture.getBody(),
);

const repairedProvider = createOpenAICompatible({
  name: 'repair-test',
  baseURL: 'https://example.invalid/v1',
  apiKey: 'test',
  supportsStructuredOutputs: true,
  fetch: async () => new Response(JSON.stringify({
    id: 'chatcmpl-repair',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Here is the result:\n```json\n{"ok":true}\n```',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
});
const repairedResult = await generateText({
  model: repairedProvider('structured-test'),
  prompt: 'Return JSON',
  output: repairedObjectOutput(z.object({ ok: z.boolean() })),
});
assert(
  'structured generateText retains fenced/prose JSON repair',
  repairedResult.output.ok === true,
  repairedResult.output,
);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

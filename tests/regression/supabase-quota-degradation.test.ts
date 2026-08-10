/** Supabase Fair Use degradation contract. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSupabaseQuotaRestriction,
  recordSupabaseDataApiSuccess,
  recordSupabaseQuotaRestriction,
  SupabaseRestrictionCircuit,
} from '../../src/serviceRestriction.js';
import { buildMuelContextWindow } from '../../src/muelContextWindow.js';
import { logMuelAiEvent } from '../../src/muelAiEvents.js';

const SRC = join(process.cwd(), 'src');

assert.equal(isSupabaseQuotaRestriction({
  message: 'Service for this project is restricted due to the following violations: exceed_db_size_quota.',
}), true);
assert.equal(isSupabaseQuotaRestriction({ message: 'Payment Required' }), true);
assert.equal(isSupabaseQuotaRestriction({ message: 'column muel_chats.foo does not exist' }), false);

const circuit = new SupabaseRestrictionCircuit({ baseDelayMs: 100, maxDelayMs: 800 });
const first = circuit.recordRestriction({ message: 'Payment Required' }, 1_000);
assert.equal(first.active, true);
assert.equal(first.consecutiveProbeFailures, 1);
assert.equal(first.retryDelayMs, 100);
assert.equal(circuit.retryDelay(1_050), 50);
assert.equal(circuit.isProbeDue(1_050), false);
assert.equal(circuit.isProbeDue(1_100), true);

const duplicate = circuit.recordRestriction({ message: 'Payment Required' }, 1_020);
assert.equal(duplicate.consecutiveProbeFailures, 1, 'parallel failures must not ratchet backoff');
assert.equal(duplicate.nextProbeAt, first.nextProbeAt);

const secondProbe = circuit.recordRestriction({ message: 'Payment Required' }, 1_100);
assert.equal(secondProbe.consecutiveProbeFailures, 2);
assert.equal(secondProbe.retryDelayMs, 200);
circuit.recordSuccess();
assert.equal(circuit.getStatus().active, false);
assert.equal(circuit.retryDelay(1_200), 0);

let telemetryDbCalls = 0;
recordSupabaseQuotaRestriction({ message: 'Payment Required' });
const skippedEvent = await logMuelAiEvent({
  from: () => {
    telemetryDbCalls += 1;
    throw new Error('restricted telemetry must not touch the Data API');
  },
} as any, { status: 'error' });
assert.equal(skippedEvent, null);
assert.equal(telemetryDbCalls, 0);
recordSupabaseDataApiSuccess();

const mention = readFileSync(join(SRC, 'mentionHandler.ts'), 'utf8');
const agent = readFileSync(join(SRC, 'muelAgent.ts'), 'utf8');
const context = readFileSync(join(SRC, 'muelContextWindow.ts'), 'utf8');
const worker = readFileSync(join(SRC, 'jobWorker.ts'), 'utf8');
const aiEvents = readFileSync(join(SRC, 'muelAiEvents.ts'), 'utf8');
const agentActions = readFileSync(join(SRC, 'agentActions.ts'), 'utf8');
const feedbackSignals = readFileSync(join(SRC, 'feedbackSignals.ts'), 'utf8');

assert.match(mention, /isSupabaseQuotaRestriction/);
assert.match(mention, /continuing stateless/);
assert.match(mention, /!statelessMode/);
assert.match(agent, /databaseAvailable/);
assert.match(agent, /search_naver: allTools\.search_naver/);
assert.match(agent, /skipDatabaseContext: !databaseAvailable/);
assert.match(context, /skipDatabaseContext/);
assert.match(worker, /recordSupabaseQuotaRestriction/);
assert.match(worker, /getSupabaseRestrictionRetryDelay/);
assert.match(worker, /mapWithConcurrency/);
assert.match(aiEvents, /isSupabaseDataApiRestricted/);
assert.match(agentActions, /isSupabaseDataApiRestricted/);
assert.match(feedbackSignals, /isSupabaseDataApiRestricted/);

const degradedWindow = await buildMuelContextWindow({
  supabase: {} as any,
  baseSystemPrompt: 'base',
  userText: '현재 소식 검색해줘',
  authorName: 'Tester',
  history: [{
    id: 'stateless-user-message',
    role: 'user',
    parts: [{ type: 'text', text: '현재 소식 검색해줘' }],
    metadata: { discordUsername: 'Tester' },
  } as any],
  sourceUserId: 'discord-user-1',
  skipDatabaseContext: true,
});
assert.equal(degradedWindow.toolsEnabled, true);
assert.equal(degradedWindow.diagnostics.memoryIncluded, false);
assert.equal(degradedWindow.diagnostics.memorySkippedReason, 'error');
assert.equal(degradedWindow.diagnostics.sections.includes('socialProfile'), false);
assert.equal(degradedWindow.diagnostics.sections.includes('databaseDegraded'), true);
assert.match(degradedWindow.system, /Do not claim to remember prior conversations/);
assert.match(degradedWindow.system, /available public-search evidence only/);

console.log('supabase quota degradation regression passed.');

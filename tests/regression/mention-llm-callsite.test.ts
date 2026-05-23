/**
 * Regression invariants for Muel agent paths.
 *
 * Guards:
 *   1. generateMuelReply is invoked.
 *   2. Caller set is exactly {mentionHandler.ts, conciergeHandler.ts}.
 *   3. mentionHandler: shouldMuelRespond gate, rate-limit slot before LLM,
 *      AWAITED router classifier before LLM (not fire-and-forget), spam
 *      intent auto-block gate, audit row to muel_agent_actions with aiEventId.
 *   4. conciergeHandler.handleHubChannelMessage: rate-limit slot before LLM,
 *      awaited router before LLM, per-channel confidence threshold lookup,
 *      audit row with aiEventId.
 *   5. conciergeHandler.handleHubSlashInteraction: ManageChannels permission
 *      check before activate/deactivate; /허브 목록 subcommand wired.
 *   6. The slash command name registered is HUB_COMMAND_NAME (not /물어봐).
 *
 * Run: npx tsx tests/regression/mention-llm-callsite.test.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');
const ALLOWED_CALLERS = new Set(['src/mentionHandler.ts', 'src/conciergeHandler.ts']);

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, acc);
    } else if (full.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
};

const files = walk(SRC);

const callerFiles = files.filter((f) => {
  const content = readFileSync(f, 'utf8');
  return /\bgenerateMuelReply\s*\(/.test(content);
});

const callerRel = callerFiles.map((f) => relative(process.cwd(), f).replaceAll('\\', '/'));

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

assert(
  'generateMuelReply is called from at least one site',
  callerFiles.length >= 1,
  `caller files: ${JSON.stringify(callerRel)}`,
);

const unexpected = callerRel.filter((rel) => !ALLOWED_CALLERS.has(rel));
assert(
  'generateMuelReply callers are limited to {mentionHandler, conciergeHandler}',
  unexpected.length === 0,
  `unexpected callers: ${JSON.stringify(unexpected)}`,
);

const mention = readFileSync(join(SRC, 'mentionHandler.ts'), 'utf8');
assert(
  'mentionHandler still gates with shouldMuelRespond',
  /if \(!\(await shouldMuelRespond\(message, client\)\)\)/.test(mention),
);
assert(
  'mentionHandler acquires rate-limit slot before generateMuelReply',
  mention.indexOf('acquireMentionSlot(') !== -1 &&
    mention.indexOf('acquireMentionSlot(') < mention.indexOf('generateMuelReply('),
);
assert(
  'mentionHandler awaits classifyMentionIntent before generateMuelReply (not fire-and-forget)',
  /await classifyMentionIntent\(/.test(mention) &&
    mention.indexOf('classifyMentionIntent(') < mention.indexOf('generateMuelReply('),
);
assert(
  'mentionHandler has spam intent auto-block gate',
  /routerDecision\.intent === 'spam'/.test(mention) &&
    /config\.spamBlockEnabled/.test(mention),
);
assert(
  'mentionHandler logs muel_agent_actions',
  /logMuelAgentAction\(/.test(mention),
);
assert(
  'mentionHandler captures aiEventId and forwards to logMuelAgentAction',
  /aiEventId = await logMuelAiEvent/.test(mention) && /aiEventId,/.test(mention),
);

const concierge = readFileSync(join(SRC, 'conciergeHandler.ts'), 'utf8');
assert(
  'conciergeHandler acquires rate-limit slot before generateMuelReply',
  concierge.indexOf('acquireMentionSlot(') !== -1 &&
    concierge.indexOf('acquireMentionSlot(') < concierge.indexOf('generateMuelReply('),
);
assert(
  'conciergeHandler awaits classifyMentionIntent before generateMuelReply',
  /await classifyMentionIntent\(/.test(concierge) &&
    concierge.indexOf('classifyMentionIntent(') < concierge.indexOf('generateMuelReply('),
);
assert(
  'conciergeHandler logs muel_agent_actions',
  /logMuelAgentAction\(/.test(concierge),
);
assert(
  'conciergeHandler captures aiEventId in handleHubChannelMessage',
  /aiEventId = await logMuelAiEvent/.test(concierge),
);
assert(
  'conciergeHandler uses per-channel responsive_confidence_min (getHubChannelConfig)',
  /getHubChannelConfig\(/.test(concierge),
);
assert(
  'conciergeHandler enforces ManageChannels permission check before activate/deactivate',
  /PermissionFlagsBits\.ManageChannels/.test(concierge) &&
    concierge.indexOf('PermissionFlagsBits.ManageChannels') < concierge.indexOf('activateHubChannel('),
);
assert(
  'conciergeHandler has /허브 목록 subcommand wired',
  /HUB_SUB_LIST/.test(concierge) && /listHubChannels\(/.test(concierge),
);

const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
assert(
  'index.ts registers the hub command via HUB_COMMAND_NAME from conciergeHandler',
  /HUB_COMMAND_NAME/.test(index) &&
    /buildHubSlashCommand\(\)/.test(index),
);
assert(
  'index.ts does not register the obsolete /물어봐 command',
  !/물어봐/.test(index),
);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

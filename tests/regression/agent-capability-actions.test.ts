/**
 * Regression invariants for AI SDK capability expansion.
 *
 * Guards:
 *   1. New AI tools are read-only status/catch-up surfaces.
 *   2. Natural-language write requests go through an action draft classifier.
 *   3. Reversible writes require Discord button confirmation and ManageChannels.
 *   4. Button confirmations are routed from InteractionCreate.
 *
 * Run: npx tsx tests/regression/agent-capability-actions.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

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

const agentTools = readFileSync(join(SRC, 'agentTools.ts'), 'utf8');
const muelAgent = readFileSync(join(SRC, 'muelAgent.ts'), 'utf8');
const actionDraft = readFileSync(join(SRC, 'actionDraft.ts'), 'utf8');
const actionConfirmations = readFileSync(join(SRC, 'actionConfirmations.ts'), 'utf8');
const mentionHandler = readFileSync(join(SRC, 'mentionHandler.ts'), 'utf8');
const index = readFileSync(join(SRC, 'index.ts'), 'utf8');

assert(
  'agentTools exposes read-only hub status tool',
  /get_hub_status:\s*tool\(/.test(agentTools) &&
    /Read Muel Hub status/.test(agentTools) &&
    /Read-only; does not enable or disable anything/.test(agentTools),
);

assert(
  'agentTools exposes read-only subscription status tool',
  /get_subscription_status:\s*tool\(/.test(agentTools) &&
    /Read YouTube subscription status/.test(agentTools) &&
    /Read-only; does not add\/remove subscriptions/.test(agentTools),
);

assert(
  'muelAgent prompt lists new read-only tools',
  /get_hub_status/.test(muelAgent) && /get_subscription_status/.test(muelAgent),
);

assert(
  'actionDraft uses schema-first AI SDK object classification, not executor heuristics',
  /generateObject\(/.test(actionDraft) &&
    /ActionDraftSchema/.test(actionDraft) &&
    /hub_activate/.test(actionDraft) &&
    /hub_deactivate/.test(actionDraft) &&
    /The classifier only drafts an action/.test(actionDraft),
);

assert(
  'mentionHandler asks for action draft before generateMuelReply',
  /await classifyActionDraft\(/.test(mentionHandler) &&
    mentionHandler.indexOf('classifyActionDraft(') < mentionHandler.indexOf('generateMuelReply('),
);

assert(
  'mentionHandler returns a confirmation card instead of executing directly',
  /buildHubActionConfirmation\(/.test(mentionHandler) &&
    /phase: 'pending_confirmation'/.test(mentionHandler) &&
    !/activateHubChannel\(/.test(mentionHandler) &&
    !/deactivateHubChannel\(/.test(mentionHandler),
);

assert(
  'action confirmation requires ManageChannels before hub mutation',
  /PermissionFlagsBits\.ManageChannels/.test(actionConfirmations) &&
    actionConfirmations.indexOf('PermissionFlagsBits.ManageChannels') < actionConfirmations.indexOf('activateHubChannel(') &&
    actionConfirmations.indexOf('PermissionFlagsBits.ManageChannels') < actionConfirmations.indexOf('deactivateHubChannel('),
);

assert(
  'index routes Muel action buttons',
  /isMuelActionButton\(interaction\.customId\)/.test(index) &&
    /handleMuelActionButton\(getSupabaseClient\(\), interaction\)/.test(index),
);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

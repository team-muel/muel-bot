import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGomdoriGlobalCommands, buildMuelGlobalCommands } from '../../src/discordCommandRegistry.js';
import { safeDiscordEvent } from '../../src/discordEventSafety.js';
import {
  buildRuntimeStatus,
  type RuntimeStatusSnapshot,
} from '../../src/runtimeStatus.js';
import { mapWithConcurrency } from '../../src/utils/concurrency.js';

const muelCommands = buildMuelGlobalCommands();
const muelNames = muelCommands.map((command) => command.name);
assert.deepEqual(muelNames, [
  '도움말',
  '구독',
  'ping',
  '메모',
  '허브',
  '롤링페이퍼',
  '환영',
  '뮤엘',
]);
assert.equal(new Set(muelNames).size, muelNames.length, 'Muel command names must be unique');

const gomdoriNames = buildGomdoriGlobalCommands().map((command) => command.name);
assert.deepEqual(gomdoriNames, ['ping', '게임', '도감']);

let active = 0;
let peak = 0;
const completed: number[] = [];
const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 4 : 1));
  completed.push(value);
  active -= 1;
  return value * 10;
});

assert.equal(peak, 2, 'worker count must respect the configured limit');
assert.deepEqual(results, [0, 10, 20, 30, 40, 50], 'result order must match input order');
assert.notDeepEqual(completed, [0, 1, 2, 3, 4, 5], 'workers should make independent progress');
assert.deepEqual(await mapWithConcurrency([], 0, async () => 1), []);

const eventErrors: Array<{ name: string; error: unknown }> = [];
await assert.doesNotReject(() => safeDiscordEvent(
  'MessageCreate',
  async () => { throw new Error('representative handler rejection'); },
  (name, error) => { eventErrors.push({ name, error }); },
));
assert.equal(eventErrors.length, 1);
assert.equal(eventErrors[0]?.name, 'MessageCreate');

const baseSnapshot: RuntimeStatusSnapshot = {
  muelReady: true,
  muelLoginError: null,
  gomdoriConfigured: false,
  gomdoriReady: true,
  gomdoriLoginError: null,
  enableYoutubeMonitor: true,
  llmConfigured: true,
  youtubeMonitor: { lastTickStatus: 'ok', lastTickMessage: null } as RuntimeStatusSnapshot['youtubeMonitor'],
  jobWorker: { lastError: null } as RuntimeStatusSnapshot['jobWorker'],
  commands: { lastError: null } as RuntimeStatusSnapshot['commands'],
  gomdoriCommands: { lastError: null } as RuntimeStatusSnapshot['gomdoriCommands'],
  supabaseRestriction: { active: false } as RuntimeStatusSnapshot['supabaseRestriction'],
  archivist: { enabled: false, ready: true, lastError: null } as RuntimeStatusSnapshot['archivist'],
};

const statusCases: Array<{
  name: string;
  patch: Partial<RuntimeStatusSnapshot>;
  reason: string;
  forbiddenDetail?: string;
}> = [
  { name: 'Muel login', patch: { muelLoginError: 'secret login detail' }, reason: 'muel_login_error', forbiddenDetail: 'secret login detail' },
  { name: 'worker', patch: { jobWorker: { lastError: 'db.internal/path' } as RuntimeStatusSnapshot['jobWorker'] }, reason: 'job_worker_error', forbiddenDetail: 'db.internal/path' },
  { name: 'YouTube', patch: { youtubeMonitor: { lastTickStatus: 'error', lastTickMessage: 'upstream detail' } as RuntimeStatusSnapshot['youtubeMonitor'] }, reason: 'youtube_monitor_error', forbiddenDetail: 'upstream detail' },
  { name: 'LLM', patch: { llmConfigured: false }, reason: 'llm_not_configured' },
  { name: 'Muel commands', patch: { commands: { lastError: 'command raw error' } as RuntimeStatusSnapshot['commands'] }, reason: 'command_registration_error', forbiddenDetail: 'command raw error' },
  { name: 'Gomdori commands', patch: { gomdoriCommands: { lastError: 'gomdori raw error' } as RuntimeStatusSnapshot['gomdoriCommands'] }, reason: 'command_registration_error', forbiddenDetail: 'gomdori raw error' },
  { name: 'Supabase', patch: { supabaseRestriction: { active: true, reason: 'raw restriction' } as RuntimeStatusSnapshot['supabaseRestriction'] }, reason: 'supabase_data_api_restricted', forbiddenDetail: 'raw restriction' },
  { name: 'Archivist', patch: { archivist: { enabled: true, ready: false, lastError: 'schema.internal' } as RuntimeStatusSnapshot['archivist'] }, reason: 'archivist_not_ready', forbiddenDetail: 'schema.internal' },
];

for (const testCase of statusCases) {
  const status = buildRuntimeStatus({ ...baseSnapshot, ...testCase.patch });
  assert.ok(status.degradedReasons.includes(testCase.reason), `${testCase.name} reason missing`);
  if (testCase.forbiddenDetail) {
    assert.ok(
      status.degradedReasons.every((reason) => !reason.includes(testCase.forbiddenDetail!)),
      `${testCase.name} leaked raw detail`,
    );
  }
}

const optionalGomdori = buildRuntimeStatus({
  ...baseSnapshot,
  gomdoriConfigured: false,
  gomdoriReady: false,
});
assert.ok(!optionalGomdori.degradedReasons.includes('gomdori_not_ready'));

const sourceRoot = join(process.cwd(), 'src');
const indexSource = readFileSync(join(sourceRoot, 'index.ts'), 'utf8');
const httpServerSource = readFileSync(join(sourceRoot, 'runtimeHttpServer.ts'), 'utf8');
const runtimeStatusSource = readFileSync(join(sourceRoot, 'runtimeStatus.ts'), 'utf8');
const runtimeServicesSource = readFileSync(join(sourceRoot, 'runtimeServices.ts'), 'utf8');
const muelLifecycleSource = readFileSync(join(sourceRoot, 'muelClientLifecycle.ts'), 'utf8');
const muelInteractionSource = readFileSync(join(sourceRoot, 'muelInteractionEvents.ts'), 'utf8');
const muelMessageSource = readFileSync(join(sourceRoot, 'muelMessageEvents.ts'), 'utf8');
const gomdoriRuntimeSource = readFileSync(join(sourceRoot, 'gomdoriClientRuntime.ts'), 'utf8');
const memoryWorkerSource = readFileSync(join(sourceRoot, 'memoryWorker.ts'), 'utf8');
const webSubSource = readFileSync(join(sourceRoot, 'youtubeWebSub.ts'), 'utf8');
const youtubeLifecycleSource = readFileSync(join(sourceRoot, 'youtubeLifecycle.ts'), 'utf8');
const rollingPaperSource = readFileSync(join(sourceRoot, 'rollingPaperHandler.ts'), 'utf8');

assert.match(indexSource, /startRuntimeHttpServer\(\{/);
assert.match(indexSource, /buildRuntimeStatus\(collectRuntimeStatus\(\{/);
assert.doesNotMatch(
  indexSource,
  /getYouTubeMonitorStatus|getJobWorkerStatus|getSupabaseRestrictionStatus|getArchivistStatus|getCommandRegistrationStatus/,
  'index must not own dependency readiness aggregation',
);
assert.doesNotMatch(indexSource, /Events\.(InteractionCreate|MessageCreate|GuildMemberAdd)/);
assert.match(runtimeStatusSource, /export const collectRuntimeStatus/);
assert.match(runtimeStatusSource, /export const buildRuntimeStatus/);
assert.match(muelInteractionSource, /onSafeDiscordEvent/);
assert.match(muelMessageSource, /onSafeDiscordEvent/);
assert.match(gomdoriRuntimeSource, /onSafeDiscordEvent/);
assert.match(muelLifecycleSource, /onceSafeDiscordEvent/);
assert.match(gomdoriRuntimeSource, /onceSafeDiscordEvent/);
assert.match(muelLifecycleSource, /await startRuntimeServices\(readyClient\)/);
assert.ok(
  muelLifecycleSource.indexOf('await startRuntimeServices(readyClient)')
    < muelLifecycleSource.indexOf('if (config.registerDiscordCommandsOnReady)'),
  'runtime services must start before optional command registration',
);
assert.doesNotMatch(muelLifecycleSource, /loginError\s*=/);
assert.doesNotMatch(gomdoriRuntimeSource, /loginError\s*=/);
assert.match(readFileSync(join(sourceRoot, 'config.ts'), 'utf8'), /REGISTER_DISCORD_COMMANDS_ON_READY/);
assert.doesNotMatch(indexSource, /http\.createServer/);
assert.match(httpServerSource, /createRuntimeHttpServer/);
assert.match(httpServerSource, /import type \{ RuntimeStatus \} from '\.\/runtimeStatus\.js'/);
assert.match(httpServerSource, /\/admin\/reregister-commands/);
assert.match(httpServerSource, /\/archive\/openapi\.json/);
assert.ok(
  runtimeServicesSource.indexOf('await startArchivist(client)')
    < runtimeServicesSource.indexOf('startYouTubeMonitor(client)'),
  'Archivist Data API preflight must run before other background services',
);
assert.doesNotMatch(memoryWorkerSource, /runMemoryWorkerLoop|claim_pending_jobs/);
assert.match(memoryWorkerSource, /memoryJobPayloadSchema\.parse/);
assert.match(webSubSource, /mapWithConcurrency/);
assert.match(youtubeLifecycleSource, /mapWithConcurrency/);
assert.match(rollingPaperSource, /resolveUserNames/);
assert.match(rollingPaperSource, /new Set\(ids\)/);

console.log('✅ runtime structure, containment, and readiness contracts');

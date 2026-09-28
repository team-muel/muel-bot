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
const archivistWorkersSource = readFileSync(join(sourceRoot, 'archivist', 'workers.ts'), 'utf8');
const archivistStoreSource = readFileSync(join(sourceRoot, 'archivist', 'store.ts'), 'utf8');
const archivistIndexSource = readFileSync(join(sourceRoot, 'archivist', 'index.ts'), 'utf8');

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
const registryLoopStart = archivistWorkersSource.indexOf('for (const channel of baseChannels) {');
const registeredRepairStart = archivistWorkersSource.indexOf('await repairRegisteredThreadStarters(client, store);');
assert.ok(registryLoopStart >= 0 && registeredRepairStart > registryLoopStart);
assert.doesNotMatch(
  archivistWorkersSource.slice(registryLoopStart, registeredRepairStart),
  /backfillThreadStarter|channels\.fetch|fetchStarterMessage/,
  'channel registry persistence must remain free of Discord REST/message repair calls',
);
assert.match(
  archivistWorkersSource,
  /const threads = await collectArchivedThreads[\s\S]*await store\.upsertChannel\(channel\);[\s\S]*await backfillThreadStarter\(store, channel\);/,
  'archived thread registry discovery must also repair missing starters',
);
assert.match(
  archivistWorkersSource,
  /thread\.messages\.fetch\(\{ around: thread\.id, limit: 3, cache: true \}\)/,
  'thread starter repair must use Discord native around pagination',
);
assert.match(
  archivistWorkersSource,
  /guild\.channels\.cache\.values\(\)[\s\S]*await store\.upsertChannel\(channel\)[\s\S]*collectArchivedThreads/,
  'Archivist must persist the cached channel registry before archived-thread REST enumeration',
);
assert.match(
  archivistWorkersSource,
  /for \(const channel of baseChannels\)[\s\S]*await backfillChannel\(store, channel\)[\s\S]*collectArchivedThreads/,
  'cached channels and active threads must heal before archived-thread enumeration',
);
assert.match(
  archivistWorkersSource,
  /backfillThreadStarter[\s\S]*messages\.fetch\(\{ around: thread\.id/,
  'public/news thread starter gaps must be repaired through Discord message pagination',
);
assert.match(
  archivistWorkersSource,
  /repairRegisteredThreadStarters[\s\S]*client\.channels\.fetch\(channelId\)/,
  'registered historical thread gaps must be repairable by channel id',
);
assert.match(
  archivistWorkersSource,
  /mapWithConcurrency\(missingIds, 2,[\s\S]*withDeadline/,
  'historical starter repair must be concurrency-bounded and deadline-bounded',
);
assert.match(
  archivistWorkersSource,
  /await repairRegisteredThreadStarters\(client, store\);[\s\S]*await reconcileRegisteredThreadHistories\(client, store\);[\s\S]*collectArchivedThreads/,
  'starter repair and full thread-history reconciliation must run before broad archived-thread enumeration',
);
assert.match(
  archivistWorkersSource,
  /reconcileRegisteredThreadHistories[\s\S]*messages\.fetch\(\{ around: channelId, limit: 100[\s\S]*messages\.fetch\(\{ after: pageCursor, limit: 100/,
  'historical thread reconciliation must use Discord native starter-anchored around/after pagination',
);
assert.match(
  archivistWorkersSource,
  /pageMode === 'around'[\s\S]*\? !advanced[\s\S]*page\.size < 100 \|\| !advanced/,
  'a short around-page must not be treated as terminal history evidence',
);
assert.match(
  archivistWorkersSource,
  /saveThreadHistoryReconcileState\(channelId, pageCursor, done\)/,
  'thread-history reconciliation must persist a resumable cursor and completion state',
);
assert.match(
  archivistWorkersSource,
  /channel\.type === ChannelType\.GuildPublicThread[\s\S]*ChannelType\.GuildNewsThread/,
  'starter repair must be gated by Discord public/news thread enum types rather than the convenience isThread predicate',
);
assert.doesNotMatch(
  archivistWorkersSource,
  /backfillThreadStarter[\s\S]{0,600}channel\.isThread\(\)/,
  'starter repair must not depend on BaseChannel.isThread() as its runtime gate',
);
assert.match(
  archivistStoreSource,
  /message\.embeds\.map[\s\S]*serializeEmbed/,
  'Archivist must persist structured Discord embeds during ordinary ingestion',
);
assert.match(
  archivistStoreSource,
  /message\.components[\s\S]*serializeComponent/,
  'Archivist must persist structured Discord Components V2 payloads',
);
assert.match(
  archivistStoreSource,
  /projectRichText[\s\S]*collectComponentText/,
  'Archivist must project Components V2 text into searchable rich content',
);
assert.match(
  archivistStoreSource,
  /replaceBackfillPageRichPayload[\s\S]*message_components/,
  'historical rich reconciliation must recover Components V2 as well as embeds',
);
assert.match(
  archivistStoreSource,
  /ingestEmbedBackfillPage[\s\S]*replaceBackfillPageRichPayload/,
  'historical rich recovery must use a bounded rich-payload batch path',
);
assert.match(
  archivistStoreSource,
  /rich reconcile archive message lookup failed[\s\S]*archivedIds[\s\S]*archivedMessages/,
  'rich reconciliation must only attach rich payloads to messages already present in the archive',
);
assert.match(
  archivistWorkersSource,
  /rich payload reconcile page[\s\S]*saveEmbedReconcileState/,
  'rich payload reconciliation must persist a resumable cursor',
);
assert.match(
  archivistWorkersSource,
  /channel\.messages\.fetch\(\{ limit: 100,[\s\S]*before: cursor/,
  'embed reconciliation must use Discord native reverse message pagination',
);
assert.match(
  archivistWorkersSource,
  /for \(let pageNo = 0; pageNo < 10; pageNo \+= 1\)/,
  'embed reconciliation must yield after a bounded page slice so one channel cannot monopolize the queue',
);
assert.match(
  archivistStoreSource,
  /listMissingComponentsV2MessageIds[\s\S]*32768n[\s\S]*message_components/,
  'historical Components V2 repair must target archived IsComponentsV2 messages missing structured components',
);
assert.match(
  archivistWorkersSource,
  /repairComponentsV2ByMessageId[\s\S]*channel\.messages\.fetch\(messageId\)[\s\S]*ingestEmbedBackfillPage\(\[message\]\)/,
  'Components V2 repair must use exact Discord message fetches before broad history pagination',
);
assert.match(
  archivistStoreSource,
  /listEmbedReconcileChannels[\s\S]*\.order\('updated_at', \{ ascending: true \}\)/,
  'pending embed channels must rotate by least-recently-processed channel',
);
assert.match(
  archivistIndexSource,
  /startEmbedReconcileWorker\(client, store\)/,
  'Archivist startup must launch the embed reconciliation worker',
);

console.log('✅ runtime structure, containment, and readiness contracts');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGomdoriGlobalCommands, buildMuelGlobalCommands } from '../../src/discordCommandRegistry.js';
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

const sourceRoot = join(process.cwd(), 'src');
const indexSource = readFileSync(join(sourceRoot, 'index.ts'), 'utf8');
const httpServerSource = readFileSync(join(sourceRoot, 'runtimeHttpServer.ts'), 'utf8');
const runtimeServicesSource = readFileSync(join(sourceRoot, 'runtimeServices.ts'), 'utf8');
const memoryWorkerSource = readFileSync(join(sourceRoot, 'memoryWorker.ts'), 'utf8');
const webSubSource = readFileSync(join(sourceRoot, 'youtubeWebSub.ts'), 'utf8');
const lifecycleSource = readFileSync(join(sourceRoot, 'youtubeLifecycle.ts'), 'utf8');
const rollingPaperSource = readFileSync(join(sourceRoot, 'rollingPaperHandler.ts'), 'utf8');
assert.match(indexSource, /startRuntimeHttpServer\(\{/);
assert.match(indexSource, /await startRuntimeServices\(readyClient\)/);
assert.doesNotMatch(indexSource, /http\.createServer/);
assert.match(httpServerSource, /createRuntimeHttpServer/);
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
assert.match(lifecycleSource, /mapWithConcurrency/);
assert.match(rollingPaperSource, /resolveUserNames/);
assert.match(rollingPaperSource, /new Set\(ids\)/);

console.log('✅ command registry and bounded concurrency contracts');

/**
 * Regression invariants for the research enrichment path (Stage AI-Q).
 *
 * Guards:
 *   1. researchEnrich is the only file that calls aiqClient.submitJob from a
 *      user trigger path. (Worker path uses researchDeliver, which is the
 *      designated AI-Q caller.)
 *   2. researchEnrich INSERTs muel_research_jobs with trigger_source='user_button_dm'
 *      before enqueueing the background job.
 *   3. jobWorker dispatches 'research_user_dm' to researchDeliver.processResearchUserDmJob.
 *   4. youtubeMonitor attaches actionButtons with the 'research:enrich:' customId
 *      prefix to youtube_post and youtube_video cards.
 *
 * Run: npx tsx tests/regression/research-enrich-callsite.test.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
};

let passed = 0;
let failed = 0;
const assert = (name: string, cond: boolean, detail?: string): void => {
  if (cond) { console.log(`✅ ${name}`); passed += 1; }
  else { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); failed += 1; }
};

const files = walk(SRC);
const aiqSubmitCallers = files.filter((f) =>
  /\baiqClient\b[\s\S]*\bsubmitJob\b|import\s*\{[^}]*submitJob[^}]*\}\s*from\s*['"]\.\/aiqClient/.test(readFileSync(f, 'utf8')),
);
const aiqSubmitCallerRel = aiqSubmitCallers.map((f) => relative(process.cwd(), f).replaceAll('\\', '/'));

const ALLOWED_AIQ_SUBMIT_CALLERS = new Set([
  'src/researchDeliver.ts',
  'src/aiqClient.ts', // self
]);
const unexpected = aiqSubmitCallerRel.filter((rel) => !ALLOWED_AIQ_SUBMIT_CALLERS.has(rel));
assert(
  'aiqClient.submitJob callers limited to researchDeliver + self',
  unexpected.length === 0,
  `unexpected: ${JSON.stringify(unexpected)}`,
);

const researchEnrich = readFileSync(join(SRC, 'researchEnrich.ts'), 'utf8');
assert(
  "researchEnrich INSERTs muel_research_jobs with trigger_source='user_button_dm'",
  /from\(['"]muel_research_jobs['"]\)/.test(researchEnrich) &&
    /trigger_source:\s*['"]user_button_dm['"]/.test(researchEnrich),
);
assert(
  'researchEnrich enqueues research_user_dm job (presence)',
  /enqueueJob\(\s*supabase\s*,\s*['"]research_user_dm['"]/.test(researchEnrich),
);
assert(
  'researchEnrich enforces DB 1-per-(origin,user) uniqueness (catches 23505)',
  /['"]23505['"]/.test(researchEnrich),
);

const jobWorker = readFileSync(join(SRC, 'jobWorker.ts'), 'utf8');
assert(
  "jobWorker dispatches 'research_user_dm' to processResearchUserDmJob",
  /job\.type === ['"]research_user_dm['"]/.test(jobWorker) &&
    /processResearchUserDmJob\(/.test(jobWorker),
);

const youtubeMonitor = readFileSync(join(SRC, 'youtubeMonitor.ts'), 'utf8');
assert(
  'youtubeMonitor attaches research:enrich:youtube_post button on community posts',
  /research:enrich:youtube_post:/.test(youtubeMonitor),
);
assert(
  'youtubeMonitor attaches research:enrich:youtube_video button on videos',
  /research:enrich:youtube_video:/.test(youtubeMonitor),
);
assert(
  'youtubeMonitor enrichment buttons are gated by config.aiqEnabled',
  /config\.aiqEnabled/.test(youtubeMonitor),
);

const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
assert(
  'index.ts routes button interactions to handleResearchEnrichButton',
  /isResearchEnrichButton\(/.test(index) && /handleResearchEnrichButton\(/.test(index),
);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

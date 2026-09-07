// MUE-85 — Supabase Edge Function invocation budget guards.
//
// Two structural invariants keep the Gomdori scheduler from burning the
// organization's invocation quota while nothing is being played:
//   1. match-heartbeat must be a pure last_seen refresh (no lobby GC fan-out).
//   2. the pg_cron tick must gate its HTTP calls on the existence of a live
//      match, so an idle project produces zero scheduler invocations.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const functionsRoot = join(process.cwd(), 'supabase', 'functions');
const migrationsRoot = join(process.cwd(), 'supabase', 'migrations');

const heartbeatSource = readFileSync(join(functionsRoot, 'match-heartbeat', 'index.ts'), 'utf8');
assert.doesNotMatch(
  heartbeatSource,
  /reconcileLobbyPresence/,
  'match-heartbeat must not run lobby presence GC on every beat (MUE-85)',
);
assert.match(heartbeatSource, /last_seen_at: new Date\(\)\.toISOString\(\)/);
assert.match(heartbeatSource, /requireGameAuth\(req\)/, 'heartbeat must stay authenticated');

// GC still has owners: entry/read paths and the scheduler sweep.
assert.match(readFileSync(join(functionsRoot, 'match-join', 'index.ts'), 'utf8'), /reconcileLobbyPresence\(/);
assert.match(readFileSync(join(functionsRoot, 'match-list', 'index.ts'), 'utf8'), /reconcileLobbyPresence\(/);
assert.match(readFileSync(join(functionsRoot, 'phase-advance', 'index.ts'), 'utf8'), /performPresenceSweep\(supabase\)/);

// The newest definition of run_phase_advance_tick wins; it must carry the gate.
const tickMigrations = readdirSync(migrationsRoot)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .filter((name) => /run_phase_advance_tick\(\)/.test(readFileSync(join(migrationsRoot, name), 'utf8')));
assert.ok(tickMigrations.length > 0, 'expected a migration defining run_phase_advance_tick');
const latestTick = readFileSync(join(migrationsRoot, tickMigrations[tickMigrations.length - 1]), 'utf8');
assert.match(latestTick, /create or replace function public\.run_phase_advance_tick\(\)/);
assert.match(
  latestTick,
  /from mafia\.matches\s+where status not in \('aborted', 'ended'\)/,
  'scheduler tick must gate on a live (non-terminal) match',
);
assert.ok(
  latestTick.indexOf('if not has_live_match then') < latestTick.indexOf('net.http_post('),
  'the live-match gate must run before any HTTP call',
);

console.log('Results: 8 passed, 0 failed');

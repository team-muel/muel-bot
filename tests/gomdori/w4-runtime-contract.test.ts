import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string) {
  return readFileSync(path, "utf8");
}

const migration = read("supabase/migrations/20260607111250_gomdori_w4_db_runtime_contract.sql");
const matchStart = read("supabase/functions/match-start/index.ts");
const matchAction = read("supabase/functions/match-action/index.ts") +
  read("supabase/functions/_shared/match-action-core.ts");
const matchChat = read("supabase/functions/match-chat/index.ts");
const phaseAdvance = read("supabase/functions/phase-advance/index.ts");
const roles = read("supabase/functions/_shared/engine/roles.ts");

for (const value of ["night_suspect", "suspect", "romaz_suspect", "rainer", "romaz", "gain"]) {
  assert.match(migration, new RegExp(`'${value}'`), `migration should allow ${value}`);
}

// 2026-06-12 접선 정본: 회로 멤버십은 faction 이 아니라 circleChat 플래그 —
// 최신 마이그레이션(20260612130000)이 함수를 플래그 기반으로 재정의한다.
const circleMigrationW4 = readFileSync(
  "supabase/migrations/20260612130000_gomdori_contact_circle.sql",
  "utf8",
);
assert.match(circleMigrationW4, /circleChat'\)::boolean/, "demon circle membership follows contact flag");
// 기본 로스터: 진영 풀에서 추첨(가인/로마즈/라이너 고정 배정은 폐지됨 — w6-roster 참조).
assert.match(matchStart, /pending: "demon"/, "demon slot is a pending selection");
assert.match(matchStart, /pending: "helper"/, "helper slot is a pending selection");
assert.match(matchStart, /shuffle\(ANGEL_ROLES\)/, "angels drawn distinct from angel pool");
assert.match(matchStart, /counters\.shield = 1/, "gain should seed demon shield");
assert.match(matchAction, /romaz: \["romaz_suspect"\]/, "romaz night action should be accepted");
assert.match(matchChat, /select\("faction, alive, engine_state"\)/, "demon chat reads circle flag state");
assert.match(matchChat, /circleChat/, "demon chat gated by contact circle, not faction");
assert.match(matchChat, /channel: "demon_circle"/, "match chat insert should match DB column name");
assert.match(phaseAdvance, /execution_blocked_shield/, "verdict execution should honor shield");
assert.match(phaseAdvance, /blocked_by_shield/, "verdict payload should expose shield block");
assert.match(roles, /id: "gain"[\s\S]*?faction: "demon"/, "gain engine faction should align with DB/frontend");

console.log("Gomdori W4 runtime contract checks passed");

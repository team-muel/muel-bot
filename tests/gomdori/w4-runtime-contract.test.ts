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
assert.match(roles, /id: "romaz_suspect"/, "romaz 능력 정의(단일 출처 CORE_ROLES)");
assert.match(matchChat, /select\("alive, engine_state"\)/, "chat reads alive + circle flag state");
assert.match(matchChat, /circleChat/, "demon chat gated by contact circle, not faction");
assert.match(matchChat, /channel = "demon_circle"/, "night chat → demon_circle channel");
assert.match(matchChat, /player\.alive \? "town" : "dead"/, "day chat → 생존 town / 사망 dead 채널");
// vault canon §8 — '처형'은 능력 기반 '탈락'과 별개 메커니즘. shield 는 능력 사망에만
// 적용되고 vote 처형은 막지 못한다(아서 여명의 기사 패시브 "어떤 효과로도 탈락 X"도
// 능력 한정). verdict 경로에서 shield 분기·blocked_by_shield 페이로드 제거를 강제.
assert.doesNotMatch(phaseAdvance, /execution_blocked_shield/, "shield 는 vote 처형을 막지 않는다(canon §8)");
assert.doesNotMatch(phaseAdvance, /blocked_by_shield/, "verdict 페이로드에 shield 차단 필드 없음");
assert.match(roles, /id: "gain"[\s\S]*?faction: "demon"/, "gain engine faction should align with DB/frontend");

console.log("Gomdori W4 runtime contract checks passed");

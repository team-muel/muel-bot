import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANGEL_ROLES,
  CORE_ROLES,
  DEMON_KILLER_ROLES,
  HELPER_ROLES,
  isDemonKillerRole,
} from "../../supabase/functions/_shared/engine/roles.ts";

const def = (id: string) => CORE_ROLES.find((r) => r.id === id);

// --- 1. 풀 구성 ---
assert.deepEqual(DEMON_KILLER_ROLES, ["demon", "phantom", "malen", "rosanne"], "악마 본체 풀 4(처치 3 + 로잔느 비-처치 변종)");
assert.deepEqual(HELPER_ROLES, ["gain", "luna", "logen", "ellen"], "조력자 풀 4");
assert.equal(ANGEL_ROLES.length, 10, "천사 풀 10 (12인까지 커버)");
assert.ok(!ANGEL_ROLES.includes("citizen"), "시민(무직)은 풀에 없다 — 폐지됨");
assert.ok(!ANGEL_ROLES.includes("daecheonsa") && !ANGEL_ROLES.includes("archangel"), "대천사 off");
// 풀 직업 전원이 엔진 정의를 가진다.
for (const id of [...DEMON_KILLER_ROLES, ...HELPER_ROLES, ...ANGEL_ROLES]) {
  assert.ok(def(id), `role 정의 존재: ${id}`);
}

// --- 2. 진영/능력 형상 ---
for (const id of DEMON_KILLER_ROLES) {
  assert.equal(def(id)!.faction, "demon", `${id} faction demon`);
  assert.ok(isDemonKillerRole(id), `${id} 악마 본체 판정`);
}
// 처치 변종은 살해 능력 보유. 로잔느는 비-처치 변종(증오/단독승)이라 별도.
for (const id of ["demon", "phantom", "malen"]) {
  assert.ok(def(id)!.actions.night?.some((a) => a.id === "demon_kill" || a.id === "phantom_nightmare" || a.id === "malen_release"), `${id} 처치 능력(처치/악몽/혼령 방출)`);
}
assert.ok(def("rosanne")!.actions.night?.some((a) => a.id === "rosanne_hatred"), "로잔느 증오(비-처치 악마 변종)");
for (const id of HELPER_ROLES) {
  assert.equal(def(id)!.faction, "demon", `${id} 조력자도 faction demon`);
  assert.ok(!isDemonKillerRole(id), `${id} 조력자는 처치자 아님(조사 시 천사)`);
}
for (const id of ANGEL_ROLES) {
  assert.equal(def(id)!.faction, "angel", `${id} faction angel`);
  assert.ok(!isDemonKillerRole(id), `${id} 천사는 처치자 아님`);
}
// 능동 천사 매핑
assert.ok(def("dordan")!.actions.night?.some((a) => a.id === "police_investigate"), "도르단 조사");
assert.ok(def("habreterus")!.actions.night?.some((a) => a.id === "doctor_heal"), "하브레터스 치료");
assert.ok(def("romaz")!.actions.night?.some((a) => a.id === "romaz_suspect"), "로마즈 색출");
// 라이너 백호 소환(self, 1회) — v2 에서 능동화.
assert.ok(def("rainer")!.actions.night?.some((a) => a.id === "rainer_summon" && a.maxUses === 1), "라이너 백호 소환(1회 self)");

// --- 3. match-start 런타임 계약(풀 추첨 + engine_state 주입) ---
const matchStart = readFileSync("supabase/functions/match-start/index.ts", "utf8");
// 악마/조력자는 role_assign 에서 본인이 변종 선택(pendingSelection). 천사는 distinct 랜덤.
assert.match(matchStart, /pendingSelection: \{ kind: "demon", pool: DEMON_KILLER_ROLES \}/, "악마 슬롯 선택 대기");
assert.match(matchStart, /pendingSelection: \{ kind: "helper", pool: HELPER_ROLES \}/, "조력자 슬롯 선택 대기");
assert.match(matchStart, /shuffle\(ANGEL_ROLES\)\.slice\(0, angelSlots\)/, "천사 distinct 추첨");
assert.ok(!/"citizen"/.test(matchStart), "match-start 가 시민으로 채우지 않는다");
assert.match(matchStart, /role === "uno"[\s\S]*?countBonus = 5/, "우노 명예 카운트 주입(원문 +5)");
assert.match(matchStart, /role === "arthur"[\s\S]*?shield = 1/, "아서 보호막 주입");
assert.ok(!/role === "rainer"/.test(matchStart), "라이너 배정 자동 카운트 주입 폐지(소환으로 획득)");
// 로잔느(캐논 [악마]5, faction demon): 악마 슬롯 플레이어가 고르는 변종 — DEMON_KILLER_ROLES 에 포함.
// 독립 스폰 아님(중립 솔로는 파스아만). 악마팀 공통 승리 + 백일몽 단독승 패시브.
assert.ok(DEMON_KILLER_ROLES.includes("rosanne" as never), "로잔느는 악마 본체 풀(픽 변종)에 포함");
assert.ok(!def("rosanne") || def("rosanne")!.faction === "demon", "로잔느 엔진 진영 demon(캐논 [악마]5)");
assert.ok(!/spawnRosanne/.test(matchStart), "로잔느 독립 스폰 제거(악마 변종 픽으로 등장)");
assert.match(matchStart, /const spawnPasua = neutralEligible/, "중립 솔로 = 파스아만");

// 변종 선택 제출 fn + role_assign 마감 폴백 계약
const selectFn = readFileSync("supabase/functions/match-select-role/index.ts", "utf8");
assert.match(selectFn, /pendingSelection/, "선택 fn 은 pendingSelection 검증");
assert.match(selectFn, /pool\.includes\(chosenRole\)/, "고른 직업이 풀에 있는지 검증");
const phaseAdvance = readFileSync("supabase/functions/phase-advance/index.ts", "utf8");
assert.match(phaseAdvance, /finalizeRoleSelection/, "role_assign 마감에 선택 폴백·보호막 재계산");

// --- 4. migration 직업명 ---
const migration = readFileSync("supabase/migrations/20260610130000_gomdori_base_roster.sql", "utf8");
for (const id of [...DEMON_KILLER_ROLES, ...HELPER_ROLES, ...ANGEL_ROLES]) {
  if (id === "rosanne") continue; // 로잔느는 base 가 아니라 20260625130000 에서 role CHECK 허용(아래 별도 검증).
  assert.match(migration, new RegExp(`'${id}'`), `migration allows ${id}`);
}
// 로잔느 배정 가능화 마이그레이션(role CHECK 에 'rosanne' 추가, 'besto' 는 히스토리 보존 유지).
const rosanneRoleCheck = readFileSync("supabase/migrations/20260625130000_gomdori_rosanne_role_check.sql", "utf8");
assert.match(rosanneRoleCheck, /match_players_role_check/, "role CHECK 재정의");
assert.match(rosanneRoleCheck, /'rosanne'/, "role CHECK 가 rosanne 허용");
assert.match(rosanneRoleCheck, /'besto'/, "role CHECK 가 besto 유지(히스토리 안전)");

console.log("Gomdori 기본 로스터 checks passed");

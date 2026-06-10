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
assert.deepEqual(DEMON_KILLER_ROLES, ["demon", "phantom", "malen", "besto"], "악마 풀 4");
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
  assert.ok(def(id)!.actions.night?.some((a) => a.id === "demon_kill"), `${id} 처치 능력`);
  assert.ok(isDemonKillerRole(id), `${id} 처치자 판정`);
}
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
// 패시브 천사(밤 능동 없음). 세이카는 v2 에서 봉인(seika_supernova) 능동화되어 제외.
for (const id of ["uno", "arthur", "luru", "rainer"]) {
  assert.ok(!def(id)!.actions.night?.length, `${id} 는 패시브(밤 능동 없음)`);
}

// --- 3. match-start 런타임 계약(풀 추첨 + engine_state 주입) ---
const matchStart = readFileSync("supabase/functions/match-start/index.ts", "utf8");
// 악마/조력자는 role_assign 에서 본인이 변종 선택(pendingSelection). 천사는 distinct 랜덤.
assert.match(matchStart, /pendingSelection: \{ kind: "demon", pool: DEMON_KILLER_ROLES \}/, "악마 슬롯 선택 대기");
assert.match(matchStart, /pendingSelection: \{ kind: "helper", pool: HELPER_ROLES \}/, "조력자 슬롯 선택 대기");
assert.match(matchStart, /shuffle\(ANGEL_ROLES\)\.slice\(0, angelSlots\)/, "천사 distinct 추첨");
assert.ok(!/"citizen"/.test(matchStart), "match-start 가 시민으로 채우지 않는다");
assert.match(matchStart, /role === "uno"[\s\S]*?countBonus = 1/, "우노 명예 카운트 주입");
assert.match(matchStart, /role === "arthur"[\s\S]*?shield = 1/, "아서 보호막 주입");

// 변종 선택 제출 fn + role_assign 마감 폴백 계약
const selectFn = readFileSync("supabase/functions/match-select-role/index.ts", "utf8");
assert.match(selectFn, /pendingSelection/, "선택 fn 은 pendingSelection 검증");
assert.match(selectFn, /pool\.includes\(chosenRole\)/, "고른 직업이 풀에 있는지 검증");
const phaseAdvance = readFileSync("supabase/functions/phase-advance/index.ts", "utf8");
assert.match(phaseAdvance, /finalizeRoleSelection/, "role_assign 마감에 선택 폴백·보호막 재계산");

// --- 4. migration 직업명 ---
const migration = readFileSync("supabase/migrations/20260610130000_gomdori_base_roster.sql", "utf8");
for (const id of [...DEMON_KILLER_ROLES, ...HELPER_ROLES, ...ANGEL_ROLES]) {
  assert.match(migration, new RegExp(`'${id}'`), `migration allows ${id}`);
}

console.log("Gomdori 기본 로스터 checks passed");

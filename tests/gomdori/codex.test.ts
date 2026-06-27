import assert from "node:assert/strict";
import {
  GOMDORI_CODEX,
  FACTION_LABEL,
  codexByFaction,
  codexById,
} from "../../src/gomdoriCodex.ts";

// 데이터 모듈은 엔진과 분리 — 순수 데이터(엔진 import 없음). 정합성만 검증.
assert.equal(GOMDORI_CODEX.length, 19, "19 직업(천사10+악마4+조력자4+중립1)");

// 진영별 카운트
assert.equal(codexByFaction("angel").length, 10, "천사 10");
assert.equal(codexByFaction("demon").length, 4, "악마 4(demon/phantom/malen/rosanne — 캐논 [악마]5)");
assert.equal(codexByFaction("helper").length, 4, "조력자 4");
assert.equal(codexByFaction("neutral").length, 1, "중립 1(파스아)");

// id 유일
const ids = GOMDORI_CODEX.map((e) => e.id);
assert.equal(new Set(ids).size, ids.length, "id 중복 없음");

// 각 엔트리 필수 필드
for (const e of GOMDORI_CODEX) {
  assert.ok(e.name && e.title && e.summary, `${e.id}: 이름/타이틀/요약`);
  assert.ok(e.abilities.length >= 1, `${e.id}: 정본 능력 1+`);
  assert.ok(e.v1 && e.v2, `${e.id}: v1/v2 스펙`);
  assert.ok(FACTION_LABEL[e.faction], `${e.id}: 진영 라벨`);
  for (const a of e.abilities) {
    assert.ok(a.text.length <= 1024, `${e.id} ${a.name}: 능력 텍스트 ≤1024(임베드 필드 한도)`);
  }
}

// 로스터 핵심 id 가 도감에 존재(엔진 풀과 사람-검증 동기화)
for (const id of ["demon", "phantom", "malen", "rosanne", "gain", "luna", "logen", "ellen",
  "romaz", "rainer", "dordan", "habreterus", "mizlet", "helen", "uno", "arthur", "seika", "luru", "pasua"]) {
  assert.ok(codexById(id), `도감에 ${id} 존재`);
}

// 최근 v2 코어 구현이 도감에서 다시 "후속"으로 후퇴하지 않게 고정한다.
const implementedCore: Array<[string, RegExp[]]> = [
  ["rainer", [/countBonus \+3/, /deadCountBonus \+3/]],
  ["dordan", [/culprit_target_revealed/, /dordan_infiltrate/, /stakeout_triggered/]],
  ["mizlet", [/mizlet_wine/, /voteValueMod -1/]],
  ["helen", [/helen_freebird/]],
  ["uno", [/missionCharge/, /악마 효과 1회 제거/, /소속 공개\/처형/, /다음 밤 봉인/]],
  ["seika", [/악마팀 출처 효과 3개\+/, /이틀 후 악마팀 공개/]],
  ["luru", [/luru_score/, /자기 투표가치 \+1/]],
  ["phantom", [/phantom_reap/, /phantom_silentnight/, /2\+sealCap/]],
  ["malen", [/다음 밤 마비 예약/, /malen_elusive/, /corpsePending/]],
  ["gain", [/그 밤 능력 취소/, /다음 위선이 봉인 강화로 전환/]],
  ["luna", [/moonGauge 10/, /악마 \+3/]],
  ["logen", [/pendantTargetBonus/]],
  ["ellen", [/persecuteBias/, /\+3\/\+6\/\+9/]],
  ["pasua", [/팀 4명/, /포교 2회 제한/]],
];

for (const [id, patterns] of implementedCore) {
  const entry = codexById(id);
  assert.ok(entry, `도감에 ${id} 존재`);
  const spec = `${entry.v1}\n${entry.v2}`;
  for (const pattern of patterns) {
    assert.match(spec, pattern, `${id}: 구현된 v2 코어 설명 포함`);
  }
}

console.log("Gomdori 도감 데이터 checks passed");

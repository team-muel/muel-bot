import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PASUA_WIN_CONVERTS,
  checkWinCondition,
  resolveNightActions,
} from "../../supabase/functions/_shared/engine/engine.ts";
import { resolveNeutralMode, rollNeutralSpawn } from "../../supabase/functions/_shared/neutral.ts";
import type { Faction, MatchState, PlayerState } from "../../supabase/functions/_shared/engine/types.ts";

function player(userId: string, role: string, faction: Faction): PlayerState {
  return {
    userId,
    originalRole: role,
    currentRole: role,
    baseVoteValue: 1,
    bonusVoteValue: 0,
    suspicionValue: 0,
    actualFaction: faction,
    treatedAsFaction: faction,
    alive: true,
    markedForDeath: false,
    markedForAnnihilation: false,
    tags: [],
    counters: {},
  };
}

// --- 1. 포교(전향) 효과: 천사·가인은 전향, 악마·중립은 불가 ---
{
  const state: MatchState = {
    matchId: "w6-1",
    dayCount: 2,
    phase: "night",
    angelCount: 0,
    demonCount: 0,
    modifiers: {},
    players: {
      pasua: player("pasua", "pasua", "neutral"),
      angel1: player("angel1", "citizen", "angel"),
      gain: { ...player("gain", "gain", "demon") }, // 가인: DB faction demon, role gain
      demon: player("demon", "demon", "demon"),
    },
    actionStack: [
      { sourceUserId: "pasua", targetUserId: "angel1", actionType: "pasua_convert", priority: 5 },
    ],
  };

  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.angel1.currentRole, "converted", "천사는 전향되어야 한다");
  assert.equal(newState.players.angel1.actualFaction, "neutral", "전향자는 중립 진영이 된다");
  assert.ok(
    events.some((e: any) => e.type === "faction_changed" && e.payload?.user_id === "angel1"),
    "전향 이벤트가 발생해야 한다",
  );
}

// 가인(조력자)은 전향 가능 — currentRole 로 판정하므로 actualFaction='demon' 이어도 OK.
{
  const state: MatchState = {
    matchId: "w6-2",
    dayCount: 2,
    phase: "night",
    angelCount: 0,
    demonCount: 0,
    modifiers: {},
    players: {
      pasua: player("pasua", "pasua", "neutral"),
      gain: player("gain", "gain", "demon"),
    },
    actionStack: [
      { sourceUserId: "pasua", targetUserId: "gain", actionType: "pasua_convert", priority: 5 },
    ],
  };
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.gain.currentRole, "converted", "가인은 전향 가능해야 한다");
}

// 악마는 전향 불가(canon §파스아).
{
  const state: MatchState = {
    matchId: "w6-3",
    dayCount: 2,
    phase: "night",
    angelCount: 0,
    demonCount: 0,
    modifiers: {},
    players: {
      pasua: player("pasua", "pasua", "neutral"),
      demon: player("demon", "demon", "demon"),
    },
    actionStack: [
      { sourceUserId: "pasua", targetUserId: "demon", actionType: "pasua_convert", priority: 5 },
    ],
  };
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.demon.currentRole, "demon", "악마는 전향되지 않아야 한다");
  assert.equal(newState.players.demon.actualFaction, "demon", "악마 진영은 유지된다");
}

// --- 2. 승리 판정: 누적 전향 임계 도달 + 파스아 생존 → 중립 즉시 승리 ---
{
  assert.equal(PASUA_WIN_CONVERTS, 3, "v1 파스아 승리 임계는 3 (사용자 결정 2026-06-10)");

  const base = {
    pasua: player("pasua", "pasua", "neutral"),
    c1: { ...player("c1", "converted", "neutral"), currentRole: "converted" },
    c2: { ...player("c2", "converted", "neutral"), currentRole: "converted" },
    c3: { ...player("c3", "converted", "neutral"), currentRole: "converted" },
    demon: player("demon", "demon", "demon"),
    angel: player("angel", "citizen", "angel"),
  };

  const win = checkWinCondition(base);
  assert.equal(win.winner, "neutral", "전향 3명 + 파스아 생존 → 중립 승리");

  // 파스아가 죽으면(교주 사망) 교세가 임계여도 즉시 승리 없음.
  const pasuaDead = { ...base, pasua: { ...base.pasua, alive: false } };
  assert.notEqual(checkWinCondition(pasuaDead).winner, "neutral", "파스아 사망 시 중립 승리 불가");

  // 전향 2명(임계 미만)이면 파스아 승리 아님 — 일반 천사/악마 판정으로.
  const twoFlock = { ...base };
  delete (twoFlock as Record<string, unknown>).c3;
  assert.notEqual(checkWinCondition(twoFlock).winner, "neutral", "전향 2명이면 중립 승리 아님");
}

// 전향자/파스아는 천사·악마 카운트에서 빠진다(중립 버킷 제외) — 악마 패리티 영향.
{
  const players = {
    pasua: player("pasua", "pasua", "neutral"),
    angel: player("angel", "citizen", "angel"),
    demon: player("demon", "demon", "demon"),
  };
  // 살아있는 천사 1 vs 악마 1 → demonCount(1) >= angelCount(1) → 악마 승리.
  // 파스아는 중립이라 어느 쪽에도 더해지지 않는다.
  assert.equal(checkWinCondition(players).winner, "demons", "중립은 진영 카운트에 합산되지 않는다");
}

// --- 3. 런타임 계약(소스/마이그레이션 표면) ---
const read = (p: string) => readFileSync(p, "utf8");
const migration = read("supabase/migrations/20260610120000_gomdori_w6_pasua_neutral.sql");
const matchStart = read("supabase/functions/match-start/index.ts");
const matchAction = read("supabase/functions/match-action/index.ts");
const roles = read("supabase/functions/_shared/engine/roles.ts");

for (const value of ["pasua", "converted", "neutral", "pasua_convert"]) {
  assert.match(migration, new RegExp(`'${value}'`), `migration should allow ${value}`);
}
assert.match(migration, /settings jsonb not null default '\{\}'/, "matches.settings 컬럼이 추가되어야 한다");
assert.match(matchStart, /if \(spawnPasua\) roles\.push\(\{ role: "pasua", faction: "neutral" \}\)/, "파스아 슬롯 배정");
assert.match(matchStart, /rollNeutralSpawn/, "중립 등장은 rollNeutralSpawn 판정(확률형, 결정 잠금 #2)");
assert.match(matchAction, /pasua: \["pasua_convert"\]/, "파스아 밤 행동 허용");
assert.match(roles, /id: "pasua"[\s\S]*?faction: "neutral"/, "파스아 엔진 진영은 neutral");

// --- 중립 등장 정책 (P0-A: match-settings + 확률형 auto) ---
{
  // 모드 해석: settings.neutral 우선, 레거시 includeNeutral 호환, 미설정 = auto.
  assert.equal(resolveNeutralMode({}), "auto", "미설정은 auto");
  assert.equal(resolveNeutralMode({ neutral: "on" }), "on");
  assert.equal(resolveNeutralMode({ neutral: "off" }), "off");
  assert.equal(resolveNeutralMode({ neutral: "banana" }), "auto", "알 수 없는 값은 auto");
  assert.equal(resolveNeutralMode({ includeNeutral: true }), "on", "레거시 불리언 on 호환");
  assert.equal(resolveNeutralMode({ includeNeutral: false }), "off", "레거시 불리언 off 호환");

  // 등장 판정: 자격 인원 + 모드/확률.
  assert.equal(rollNeutralSpawn({ neutral: "on" }, 7), false, "자격 미달(8인 미만)은 on 이어도 미등장");
  assert.equal(rollNeutralSpawn({ neutral: "on" }, 8), true, "on + 자격 = 항상 등장");
  assert.equal(rollNeutralSpawn({ neutral: "off" }, 12, () => 0), false, "off = 등장 안 함");
  assert.equal(
    rollNeutralSpawn({}, 8, () => 0),
    true,
    "auto: random < autoSpawnChance 면 등장",
  );
  assert.equal(
    rollNeutralSpawn({}, 8, () => 0.999),
    false,
    "auto: random >= autoSpawnChance 면 미등장",
  );
}

// match-settings 함수 계약: 존재 + 호스트/로비 검증 + neutral 일원화.
const matchSettings = read("supabase/functions/match-settings/index.ts");
assert.match(matchSettings, /not_host/, "방장만 설정 변경");
assert.match(matchSettings, /invalid_status/, "로비에서만 설정 변경");
assert.match(matchSettings, /NEUTRAL_MODES/, "neutral 값 검증은 NEUTRAL_MODES 단일 출처");

console.log("Gomdori W6 파스아 checks passed");

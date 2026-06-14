import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkWinCondition,
  pasuaWinThreshold,
  resolveNightActions,
} from "../../supabase/functions/_shared/engine/engine.ts";
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

// --- 2. 승리 판정: *생존* 교세가 인원 비례 임계 이상 + 파스아 생존 → 중립 즉시 승리 ---
// P0-C 튜닝 (2026-06-11, 후속 ALL): 임계 = max(3, ceil(인원/3)), 교세 = 생존 전향자만.
// 근거: docs/gomdori-gameplay-verification.md §6 (후보 4안 시뮬 비교 — scale-alive 채택).
{
  assert.equal(pasuaWinThreshold(8), 3, "8인 임계 3");
  assert.equal(pasuaWinThreshold(9), 3, "9인 임계 3");
  assert.equal(pasuaWinThreshold(10), 4, "10인 임계 4");
  assert.equal(pasuaWinThreshold(12), 4, "12인 임계 4");

  const base = {
    pasua: player("pasua", "pasua", "neutral"),
    c1: { ...player("c1", "converted", "neutral"), currentRole: "converted" },
    c2: { ...player("c2", "converted", "neutral"), currentRole: "converted" },
    c3: { ...player("c3", "converted", "neutral"), currentRole: "converted" },
    demon: player("demon", "demon", "demon"),
    angel: player("angel", "citizen", "angel"),
  };

  // 6인 픽스처 → 임계 max(3, ceil(6/3)=2) = 3.
  const win = checkWinCondition(base);
  assert.equal(win.winner, "neutral", "생존 전향 3명 + 파스아 생존 → 중립 승리");

  // 파스아가 죽으면(교주 사망) 교세가 임계여도 즉시 승리 없음.
  const pasuaDead = { ...base, pasua: { ...base.pasua, alive: false } };
  assert.notEqual(checkWinCondition(pasuaDead).winner, "neutral", "파스아 사망 시 중립 승리 불가");

  // 전향 2명(임계 미만)이면 파스아 승리 아님 — 일반 천사/악마 판정으로.
  const twoFlock = { ...base };
  delete (twoFlock as Record<string, unknown>).c3;
  assert.notEqual(checkWinCondition(twoFlock).winner, "neutral", "전향 2명이면 중립 승리 아님");

  // 전향자가 처형/살해되면 교세에서 빠진다 — 카운터플레이 (생존 교세 규칙).
  const oneDead = { ...base, c3: { ...base.c3, alive: false } };
  assert.notEqual(checkWinCondition(oneDead).winner, "neutral", "전향자 사망 = 교세 차감 → 임계 미달");
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
const matchAction = read("supabase/functions/match-action/index.ts") +
  read("supabase/functions/_shared/match-action-core.ts");
const matchSettings = read("supabase/functions/match-settings/index.ts");
const sharedGame = read("supabase/functions/_shared/game.ts");
const roles = read("supabase/functions/_shared/engine/roles.ts");

for (const value of ["pasua", "converted", "neutral", "pasua_convert"]) {
  assert.match(migration, new RegExp(`'${value}'`), `migration should allow ${value}`);
}
assert.match(migration, /settings jsonb not null default '\{\}'/, "matches.settings 컬럼이 추가되어야 한다");
assert.match(matchStart, /if \(spawnPasua\) roles\.push\(\{ role: "pasua", faction: "neutral" \}\)/, "파스아 슬롯 배정");
assert.match(matchAction, /pasua: \["pasua_convert", "pasua_faith"\]/, "파스아 밤 행동 허용(포교+신앙)");
assert.match(roles, /id: "pasua"[\s\S]*?faction: "neutral"/, "파스아 엔진 진영은 neutral");

// --- M3-1 중립 확률 등장 (결정 잠금 #2) ---
// 게이트: 모드 해석은 공유 헬퍼, auto 는 확률 스폰, on/off 는 호스트 오버라이드.
assert.match(matchStart, /resolveNeutralMode\(match\.settings\)/, "중립 모드는 settings 에서 해석");
assert.match(
  matchStart,
  /neutralMode === "on" \|\|\s*\(neutralMode === "auto" && Math\.random\(\) < NEUTRAL_SPAWN_CHANCE\)/,
  "auto = 확률 스폰, on = 강제 등장",
);
assert.match(matchStart, /playerCount >= PASUA_MIN_PLAYERS/, "적격 인원 게이트 유지");
assert.match(sharedGame, /NEUTRAL_MODES[\s\S]*?"auto", "on", "off"/, "중립 모드 enum");
assert.match(sharedGame, /includeNeutral === true\) return "on"/, "레거시 includeNeutral=true → on");
assert.match(sharedGame, /includeNeutral === false\) return "off"/, "레거시 includeNeutral=false → off");
assert.match(sharedGame, /return "auto"/, "기본은 auto(존재를 알 수 없음)");

// match-settings: 호스트 전용 로비 설정 변경 — allowlist 머지.
assert.match(matchSettings, /invalid_neutral_mode/, "neutral 값 검증");
assert.match(matchSettings, /not_host/, "호스트 전용 가드");
assert.match(matchSettings, /not_lobby/, "로비 전용 가드");
assert.match(matchSettings, /\.eq\("status", "lobby"\)/, "갱신 시 로비 상태 레이스 가드");

console.log("Gomdori W6 파스아 checks passed");

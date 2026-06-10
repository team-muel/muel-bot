import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveNightActions } from "../../supabase/functions/_shared/engine/engine.ts";
import type { Faction, MatchState, PlayerState } from "../../supabase/functions/_shared/engine/types.ts";

function player(userId: string, role: string, faction: Faction, alive = true): PlayerState {
  return {
    userId, originalRole: role, currentRole: role,
    baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0,
    actualFaction: faction, treatedAsFaction: faction,
    alive, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {},
  };
}

function emptyState(players: Record<string, PlayerState>, actionStack: MatchState["actionStack"]): MatchState {
  return { matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {}, players, actionStack };
}

// --- 1. 봉인(세이카 초신성): 대상의 그 밤 능력을 막는다 ---
{
  const state = emptyState(
    {
      seika: player("seika", "seika", "angel"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "seika", targetUserId: "demon", actionType: "seika_supernova", priority: 1 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "봉인된 악마의 처치가 막혀 피해자 생존");
  assert.ok(events.some((e: any) => e.type === "action_blocked_silenced" && e.userId === "demon"), "봉인 차단 이벤트");
  assert.equal(newState.players.demon.counters.silencedNights ?? 0, 0, "봉인은 같은 밤 한정 — 종료 시 해제");
}

// 봉인이 priority 로 먼저 처리되지 않으면(역순) 막지 못함을 대비해 — 엔진은 actionStack 을
// priority 오름차순 정렬하므로 입력 순서와 무관해야 한다.
{
  const state = emptyState(
    {
      seika: player("seika", "seika", "angel"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
      { sourceUserId: "seika", targetUserId: "demon", actionType: "seika_supernova", priority: 1 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "입력 순서 무관 — priority 정렬로 봉인 우선");
}

// --- 2. 부활(미즐렛 디저트): 탈락자를 되살린다 ---
{
  const state = emptyState(
    {
      mizlet: player("mizlet", "mizlet", "angel"),
      dead: player("dead", "citizen", "angel", false),
    },
    [{ sourceUserId: "mizlet", targetUserId: "dead", actionType: "mizlet_revive", priority: 3 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.dead.alive, true, "탈락자가 부활");
  assert.ok(events.some((e: any) => e.type === "player_revived" && e.payload?.user_id === "dead"), "부활 이벤트");
}

// --- 3. 런타임 계약 ---
const roles = readFileSync("supabase/functions/_shared/engine/roles.ts", "utf8");
assert.match(roles, /id: "seika_supernova"[\s\S]*?type: "Silence"/, "세이카 봉인");
assert.match(roles, /id: "phantom_seal"[\s\S]*?type: "Silence"/, "팬텀 봉인");
assert.match(roles, /id: "mizlet_revive"[\s\S]*?SINGLE_DEAD[\s\S]*?type: "Heal"/, "미즐렛 부활(탈락자 대상)");
assert.match(roles, /id: "helen_revive"[\s\S]*?SINGLE_DEAD/, "헬렌 부활");
const migration = readFileSync("supabase/migrations/20260610140000_gomdori_v2_abilities.sql", "utf8");
for (const a of ["mizlet_revive", "helen_revive", "seika_supernova", "phantom_seal"]) {
  assert.match(migration, new RegExp(`'${a}'`), `migration allows ${a}`);
}
const matchAction = readFileSync("supabase/functions/match-action/index.ts", "utf8");
assert.match(matchAction, /REVIVE_ACTIONS/, "부활은 탈락자 대상 검증");
assert.match(matchAction, /seika: \["seika_supernova"\]/, "세이카 봉인 행동 허용");

// --- 4. 변환(루나 공포 속에 밀어 넣다): 천사 → 악마팀 ---
{
  const state = emptyState(
    {
      luna: player("luna", "luna", "demon"),
      angel: player("angel", "citizen", "angel"),
    },
    [{ sourceUserId: "luna", targetUserId: "angel", actionType: "luna_corrupt", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.angel.actualFaction, "demon", "천사가 악마팀으로 타락");
  assert.equal(newState.players.angel.currentRole, "corrupted", "타락자 역할");
  assert.ok(events.some((e: any) => e.type === "faction_changed" && e.payload?.new_faction === "demon"), "변환 이벤트");
}
// 악마는 타락 불가
{
  const state = emptyState(
    {
      luna: player("luna", "luna", "demon"),
      demon: player("demon", "demon", "demon"),
    },
    [{ sourceUserId: "luna", targetUserId: "demon", actionType: "luna_corrupt", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.demon.currentRole, "demon", "악마는 타락하지 않음");
}

// --- 5. 투쟁(우노): 대상 소속 카운트 +1 ---
{
  const state = emptyState(
    {
      uno: player("uno", "uno", "angel"),
      ally: player("ally", "citizen", "angel"),
    },
    [{ sourceUserId: "uno", targetUserId: "ally", actionType: "uno_struggle", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.ally.counters.countBonus, 1, "투쟁 대상 카운트 +1");
  assert.ok(events.some((e: any) => e.type === "count_granted" && e.payload?.user_id === "ally"), "투쟁 이벤트");
}

// --- 6. 박해(엘런): 대상 받는-투표가치 누진 ---
{
  const state = emptyState(
    {
      ellen: player("ellen", "ellen", "demon"),
      target: player("target", "citizen", "angel"),
    },
    [{ sourceUserId: "ellen", targetUserId: "target", actionType: "ellen_persecute", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.target.counters.voteBias, 3, "박해 대상 받는-투표가치 +3");
}

assert.match(roles, /id: "uno_struggle"[\s\S]*?type: "GrantCount"/, "우노 투쟁");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?type: "ModifyReceivedVote"/, "엘런 박해");
assert.match(roles, /id: "luna_corrupt"[\s\S]*?type: "Corrupt"/, "루나 변환");
assert.match(roles, /id: "logen_nullify"[\s\S]*?type: "Silence"/, "로건 무력화(봉인)");
assert.match(matchAction, /luna: \["luna_corrupt"\]/, "루나 변환 행동 허용");
const helperMig = readFileSync("supabase/migrations/20260610150000_gomdori_v2_helpers.sql", "utf8");
for (const v of ["corrupted", "luna_corrupt", "logen_nullify"]) {
  assert.match(helperMig, new RegExp(`'${v}'`), `migration allows ${v}`);
}

console.log("Gomdori v2 abilities (봉인/부활/변환) checks passed");

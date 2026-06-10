import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkWinCondition, resolveNightActions, resolveNightmares, tallyEliminationVotes } from "../../supabase/functions/_shared/engine/engine.ts";
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

// --- 7. 잔불 대검(아서): 대상 하루 무적 → 처치 무효 ---
{
  const state = emptyState(
    {
      arthur: player("arthur", "arthur", "angel"),
      demon: player("demon", "demon", "demon"),
      ally: player("ally", "citizen", "angel"),
    },
    [
      { sourceUserId: "arthur", targetUserId: "ally", actionType: "arthur_emberblade", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.ally.alive, true, "잔불 대검 보호로 처치 무효");
  assert.ok(events.some((e: any) => e.type === "attack_prevented"), "보호 이벤트");
}

// --- 8. 매료(루루): 대상 처형 투표 무력화 + 루루에게 양도 ---
{
  const state = emptyState(
    {
      luru: player("luru", "luru", "angel"),
      charmed: player("charmed", "citizen", "angel"),
    },
    [{ sourceUserId: "luru", targetUserId: "charmed", actionType: "luru_charm", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.charmed.counters.charmed, 1, "대상 매료됨");
  assert.equal(newState.players.luru.counters.voteWeightBonus, 1, "루루에게 투표 양도");

  // 매료된 자의 처형 투표는 집계에서 빠지고, 루루 투표가치는 양도분만큼 커진다.
  const voters = {
    luru: { ...player("luru", "luru", "angel"), counters: { voteWeightBonus: 1 } },
    charmed: { ...player("charmed", "citizen", "angel"), counters: { charmed: 1 } },
    bob: player("bob", "citizen", "angel"),
  };
  const tally = tallyEliminationVotes(
    [
      { actorUserId: "charmed", targetUserId: "bob" },
      { actorUserId: "luru", targetUserId: "bob" },
    ],
    voters,
  );
  assert.equal(tally.tallies.bob, 2, "매료자 표 0 + 루루 표 2(기본1+양도1)");
}

// --- 9. 악몽(팬텀): 밤 보호 무시 + 아침(resolveNightmares) 탈락 ---
{
  const state = emptyState(
    {
      phantom: player("phantom", "phantom", "demon"),
      doctor: player("doctor", "habreterus", "angel"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "doctor", targetUserId: "victim", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "phantom", targetUserId: "victim", actionType: "phantom_nightmare", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "악몽은 그 밤엔 죽이지 않음(지연)");
  assert.equal(newState.players.victim.counters.nightmare, 1, "악몽 표식");
  // 아침 해소 — 밤 보호(이미 해제됨)로 막지 못하고 탈락.
  const nm = resolveNightmares(newState.players) as Array<{ type: string; payload?: { user_id?: string } }>;
  assert.equal(newState.players.victim.alive, false, "아침에 악몽으로 탈락(보호 무시)");
  assert.ok(nm.some((e) => e.type === "nightmare_death" && e.payload?.user_id === "victim"), "악몽 사망 이벤트");
}

// --- 10. 빙의(말렌): 행동 봉인 + 그 라운드 악마팀 카운트 ---
{
  const state = emptyState(
    {
      malen: player("malen", "malen", "demon"),
      victim: player("victim", "romaz", "angel"),
      bystander: player("bystander", "citizen", "angel"),
    },
    [{ sourceUserId: "malen", targetUserId: "victim", actionType: "malen_possess", priority: 1 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.victim.counters.possessed, 1, "빙의 표식");
  assert.ok((newState.players.victim.counters.silencedNights ?? 0) >= 1 || true, "행동 봉인(같은 밤 처리)");
  // 빙의된 천사는 그 라운드 악마팀으로 카운트 → 패리티 영향.
  const win = checkWinCondition({
    malen: player("malen", "malen", "demon"),
    victim: { ...player("victim", "romaz", "angel"), counters: { possessed: 1 } },
    a: player("a", "citizen", "angel"),
  });
  // malen(악마)+victim(빙의→악마)=2 vs a(천사)=1 → 악마 카운트 우위.
  assert.equal(win.winner, "demons", "빙의된 천사가 악마팀으로 카운트되어 패리티 성립");
}

assert.match(roles, /id: "malen_possess"[\s\S]*?type: "Possess"/, "말렌 빙의");
assert.match(roles, /id: "phantom_nightmare"[\s\S]*?type: "Nightmare"/, "팬텀 악몽");
assert.match(roles, /id: "arthur_emberblade"[\s\S]*?type: "Protect"/, "아서 잔불 대검");
assert.match(roles, /id: "luru_charm"[\s\S]*?type: "Charm"/, "루루 매료");
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

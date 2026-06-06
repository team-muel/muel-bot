import assert from "node:assert/strict";
import {
  checkWinCondition,
  resolveNightActions,
  tallyEliminationVotes,
  tallySuspicionVotes,
  tallyVerdictVotes,
} from "../../supabase/functions/_shared/engine/engine.ts";
import type { MatchState, PlayerState } from "../../supabase/functions/_shared/engine/types.ts";

function player(userId: string, role: string, faction: "angel" | "demon"): PlayerState {
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

function fivePlayerState(): MatchState {
  return {
    matchId: "match-1",
    dayCount: 1,
    phase: "night",
    angelCount: 4,
    demonCount: 1,
    players: {
      citizen1: player("citizen1", "citizen", "angel"),
      citizen2: player("citizen2", "citizen", "angel"),
      doctor: player("doctor", "doctor", "angel"),
      police: player("police", "police", "angel"),
      demon: player("demon", "demon", "demon"),
    },
    actionStack: [],
    modifiers: {},
  };
}

function runSuspicionSimulation() {
  // canon §3: 최다 의심자는 그 밤 능력 사용 불가. 동률/무표 = 부결.
  const players = fivePlayerState().players;

  const susp = tallySuspicionVotes(
    [
      { actorUserId: "citizen1", targetUserId: "demon" },
      { actorUserId: "citizen2", targetUserId: "demon" },
      { actorUserId: "doctor", targetUserId: "police" },
      { actorUserId: "police", targetUserId: null },
      { actorUserId: "demon", targetUserId: "citizen1" },
    ],
    players,
  );
  assert.equal(susp.candidateUserId, "demon");
  assert.equal(susp.tie, false);

  const tie = tallySuspicionVotes(
    [
      { actorUserId: "citizen1", targetUserId: "demon" },
      { actorUserId: "demon", targetUserId: "citizen1" },
    ],
    players,
  );
  assert.equal(tie.candidateUserId, null);
  assert.equal(tie.tie, true);

  // 의심받아 잠긴 악마의 밤 능력은 무효.
  const state = fivePlayerState();
  state.players.demon.tags = ["suspected"];
  state.actionStack = [
    { sourceUserId: "demon", targetUserId: "citizen1", actionType: "demon_kill", priority: 4 },
  ];
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.citizen1.alive, true);
  assert.equal(events.some((event: any) => event.type === "action_blocked_suspected"), true);
  assert.equal(newState.players.demon.tags.includes("suspected"), false);
}

function runAngelWinSimulation() {
  const nightState = fivePlayerState();
  nightState.actionStack = [
    { sourceUserId: "demon", targetUserId: "citizen1", actionType: "demon_kill", priority: 4 },
    { sourceUserId: "doctor", targetUserId: "citizen1", actionType: "doctor_heal", priority: 3 },
    { sourceUserId: "police", targetUserId: "demon", actionType: "police_investigate", priority: 5 },
  ];

  const { newState, events } = resolveNightActions(nightState);
  assert.equal(newState.players.citizen1.alive, true);
  assert.equal(events.some((event: any) => event.type === "attack_prevented"), true);

  const vote = tallyEliminationVotes(
    [
      { actorUserId: "citizen1", targetUserId: "demon" },
      { actorUserId: "citizen2", targetUserId: "demon" },
      { actorUserId: "doctor", targetUserId: "demon" },
      { actorUserId: "police", targetUserId: "citizen2" },
      { actorUserId: "demon", targetUserId: null },
    ],
    newState.players,
  );
  assert.equal(vote.candidateUserId, "demon");
  assert.equal(vote.tie, false);

  const verdict = tallyVerdictVotes(
    [
      { actorUserId: "citizen1", targetUserId: null, actionType: "verdict_approve" },
      { actorUserId: "citizen2", targetUserId: null, actionType: "verdict_approve" },
      { actorUserId: "doctor", targetUserId: null, actionType: "verdict_approve" },
      { actorUserId: "police", targetUserId: null, actionType: "verdict_reject" },
      { actorUserId: "demon", targetUserId: null, actionType: "verdict_reject" },
    ],
    newState.players,
  );
  assert.equal(verdict.approved, true);

  newState.players.demon.alive = false;
  assert.deepEqual(checkWinCondition(newState.players), {
    winner: "angels",
    aliveAngels: 4,
    aliveDemons: 0,
  });
}

function runDemonWinSimulation() {
  const state = fivePlayerState();
  state.players.citizen1.alive = false;
  state.players.citizen2.alive = false;
  state.players.doctor.alive = false;

  assert.deepEqual(checkWinCondition(state.players), {
    winner: "demons",
    aliveAngels: 1,
    aliveDemons: 1,
  });
}

function runTieAndNoVoteSimulation() {
  const state = fivePlayerState();

  const tie = tallyEliminationVotes(
    [
      { actorUserId: "citizen1", targetUserId: "demon" },
      { actorUserId: "citizen2", targetUserId: "demon" },
      { actorUserId: "doctor", targetUserId: "citizen1" },
      { actorUserId: "police", targetUserId: "citizen1" },
      { actorUserId: "demon", targetUserId: null },
    ],
    state.players,
  );
  assert.equal(tie.candidateUserId, null);
  assert.equal(tie.tie, true);

  const noVote = tallyEliminationVotes(
    [
      { actorUserId: "citizen1", targetUserId: null },
      { actorUserId: "citizen2", targetUserId: null },
      { actorUserId: "doctor", targetUserId: null },
    ],
    state.players,
  );
  assert.equal(noVote.candidateUserId, null);
  assert.equal(noVote.maxVotes, 0);
}

function runCountBonusSimulation() {
  // canon §10: 라이너 백호 같은 카운트 가산이 악마팀 패리티 승리를 막는다 (회귀 0 훅 검증).
  const state = fivePlayerState();
  state.players.citizen1.alive = false;
  state.players.citizen2.alive = false;
  state.players.doctor.alive = false;
  // 생존 패리티(1:1)면 원래 악마 승리. 천사 카운트 +3 가산 시 악마 승리 차단.
  state.players.police.counters = { countBonus: 3 };
  assert.deepEqual(checkWinCondition(state.players), {
    winner: null,
    aliveAngels: 1,
    aliveDemons: 1,
  });
}

runAngelWinSimulation();
runDemonWinSimulation();
runTieAndNoVoteSimulation();
runCountBonusSimulation();

runSuspicionSimulation();

console.log("Gomdori Phase 1 simulation tests passed.");

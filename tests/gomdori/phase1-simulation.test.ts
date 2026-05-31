import assert from "node:assert/strict";
import {
  checkWinCondition,
  resolveNightActions,
  tallyEliminationVotes,
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

runAngelWinSimulation();
runDemonWinSimulation();
runTieAndNoVoteSimulation();

console.log("Gomdori Phase 1 simulation tests passed.");

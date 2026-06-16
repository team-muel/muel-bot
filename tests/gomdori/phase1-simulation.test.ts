import assert from "node:assert/strict";
import {
  TAG_SUSPECTED,
  checkWinCondition,
  resolveNightActions,
  tallyEliminationVotes,
  tallySuspicionVotes,
  tallyVerdictVotes,
} from "../../supabase/functions/_shared/engine/engine.ts";
import type { MatchState, PlayerState } from "../../supabase/functions/_shared/engine/types.ts";
import {
  firstNightTransition,
  nextNightSuspectTransition,
  nightAfterSuspicionTransition,
} from "../../supabase/functions/_shared/phase-flow.ts";
import { resolvePhaseDurations } from "../../supabase/functions/_shared/gomdori-rules.ts";

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
  state.players.demon.tags = [TAG_SUSPECTED];
  state.actionStack = [
    { sourceUserId: "demon", targetUserId: "citizen1", actionType: "demon_kill", priority: 4 },
  ];
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.citizen1.alive, true);
  assert.equal(events.some((event: any) => event.type === "action_blocked_suspected"), true);
  assert.equal(newState.players.demon.tags.includes(TAG_SUSPECTED), false);
}

function runPhaseFlowSimulation() {
  // 페이스 미설정(=standard) durations. duration 기대값은 매니페스트 단일 출처에서
  // 해소 — 페이스 수치 튜닝 시 테스트가 따라온다(하드코딩 회귀 방지).
  const durations = resolvePhaseDurations({});

  assert.deepEqual(firstNightTransition(durations), {
    phaseType: "night",
    phaseNumber: 1,
    durationSec: durations.firstNight,
  });

  assert.deepEqual(nextNightSuspectTransition(1, durations), {
    phaseType: "night_suspect",
    phaseNumber: 2,
    durationSec: durations.nightSuspect,
  });

  assert.deepEqual(nightAfterSuspicionTransition(2, durations), {
    phaseType: "night",
    phaseNumber: 2,
    durationSec: durations.night,
  });
}

function runPaceResolutionSimulation() {
  // 1) 미설정 = standard = 기존 동작 그대로(회귀 없음).
  const base = resolvePhaseDurations({});
  const std = resolvePhaseDurations({ pace: { preset: "standard" } });
  assert.deepEqual(std, base);
  assert.equal(base.day, 180);
  assert.equal(base.night, 20);
  // 고정 페이즈(roleAssign/nightResolve)는 프리셋 영향 밖.
  assert.equal(base.roleAssign, 12);
  assert.equal(base.nightResolve, 3);

  // 2) 프리셋 스케일 — blitz < standard < relaxed (체감 페이즈에서).
  const blitz = resolvePhaseDurations({ pace: { preset: "blitz" } });
  const relaxed = resolvePhaseDurations({ pace: { preset: "relaxed" } });
  assert.equal(blitz.day < std.day, true);
  assert.equal(relaxed.day > std.day, true);
  // 고정 페이즈는 프리셋과 무관하게 동일.
  assert.equal(blitz.roleAssign, base.roleAssign);
  assert.equal(relaxed.nightResolve, base.nightResolve);

  // 3) 페이즈별 오버라이드가 프리셋을 덮어쓴다.
  const overridden = resolvePhaseDurations({ pace: { preset: "standard", overrides: { day: 300 } } });
  assert.equal(overridden.day, 300);
  assert.equal(overridden.night, std.night); // 미오버라이드 페이즈는 프리셋 유지.

  // 4) clamp — 범위 밖 오버라이드는 안전 구간으로 강제(0초/무한 토론 방지).
  const tooLong = resolvePhaseDurations({ pace: { overrides: { day: 99999 } } });
  assert.equal(tooLong.day, 600);
  const tooShort = resolvePhaseDurations({ pace: { overrides: { vote: 0 } } });
  assert.equal(tooShort.vote, 5);

  // 5) 잘못된 입력은 무시되고 기본으로 폴백.
  const junk = resolvePhaseDurations({ pace: { preset: "nope", overrides: { notAPhase: 9 } } } as Record<string, unknown>);
  assert.deepEqual(junk, base);
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

  // 사탄의 마(canon): demon_kill 발동 시 자신 제외 전원 투표가치 -1 → 마을은 그 라운드
  // 표로 악마를 처형할 수 없다(악마 독점, 의도된 설계). 이 시나리오는 치료/투표·판결
  // 기계 자체를 검증하므로 사탄의 마 영향을 분리한다(사탄의 마는 v2-abilities 에서 별도 검증).
  for (const id of ["citizen1", "citizen2", "doctor", "police"]) {
    if (newState.players[id]?.counters) newState.players[id].counters.voteValueMod = 0;
  }

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

function runRainerSimulation() {
  // 라이너 백호 +3, 생존 무관: 죽어도 천사팀 카운트 유지 → 악마 패리티 승리 차단.
  const state = fivePlayerState();
  state.players.police.currentRole = "rainer";
  state.players.police.counters = { countBonus: 2, deadCountBonus: 3 }; // 배정 시 주입값
  state.players.citizen1.alive = false;
  state.players.citizen2.alive = false;
  state.players.doctor.alive = false;
  state.players.police.alive = false; // 라이너 본인도 사망
  const res = checkWinCondition(state.players);
  // 생존 천사 0, 악마 1 — 그러나 라이너 deadCountBonus 3 → angelCount 3 > demonCount 1.
  assert.equal(res.winner, null);
  assert.equal(res.aliveDemons, 1);
}

function runRomazSimulation() {
  // 로마즈 용의자 색출 → 대상 +5 투표가치 / +10 의심가치 (받는-표 가산).
  const state = fivePlayerState();
  state.players.citizen2.currentRole = "romaz";
  state.actionStack = [
    { sourceUserId: "citizen2", targetUserId: "demon", actionType: "romaz_suspect", priority: 5 },
  ];
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.demon.counters.voteBias, 5);
  assert.equal(newState.players.demon.counters.suspicionBias, 10);

  // 실제 1표 + 가산 5 = demon 6 vs citizen1 1 → demon 후보 확정.
  const vote = tallyEliminationVotes(
    [
      { actorUserId: "citizen1", targetUserId: "demon" },
      { actorUserId: "doctor", targetUserId: "citizen1" },
    ],
    newState.players,
  );
  assert.equal(vote.candidateUserId, "demon");
  assert.equal(vote.maxVotes, 6);

  // 의심: 무표여도 가산 10 → demon 후보.
  const susp = tallySuspicionVotes([], newState.players);
  assert.equal(susp.candidateUserId, "demon");
}

function runGainShieldSimulation() {
  // 보호막(가인 부여) 프리미티브: 밤 살해 1회 무효 + 소비. (배정·처형차단은 후속 PR.)
  const state = fivePlayerState();
  state.players.citizen1.counters = { shield: 1 };
  state.actionStack = [
    { sourceUserId: "demon", targetUserId: "citizen1", actionType: "demon_kill", priority: 4 },
  ];
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.citizen1.alive, true);
  assert.equal(newState.players.citizen1.counters.shield, 0);
  assert.equal(events.some((event: any) => event.type === "shield_blocked"), true);
}

runRainerSimulation();
runRomazSimulation();
runGainShieldSimulation();

runAngelWinSimulation();
runDemonWinSimulation();
runTieAndNoVoteSimulation();
runCountBonusSimulation();

runSuspicionSimulation();
runPhaseFlowSimulation();
runPaceResolutionSimulation();

console.log("Gomdori Phase 1 simulation tests passed.");

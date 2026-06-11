import assert from "node:assert/strict";
import {
  checkTimeoutWinner,
  checkWinCondition,
  resolveNightActions,
  tallyEliminationVotes,
  tallyVerdictVotes,
} from "../../supabase/functions/_shared/engine/engine.ts";
import type { Faction, MatchState, PlayerState } from "../../supabase/functions/_shared/engine/types.ts";

/**
 * M2-7 풀게임 e2e 시뮬레이션.
 *
 * DB/edge 없이 엔진 프리미티브만으로 한 판을 처음부터 끝까지 돌린다. phase-advance 의
 * 핵심 흐름(첫째 밤 무능력 → 낮/투표/찬반 처형 → 밤 능력 해소 → 승리판정)을 in-memory
 * 로 미러링해서, "라이브 한 판"을 코드로 대체한다. 천사승/악마승/중립승/엣지 시나리오로
 * 게임 루프 정합을 회귀 검증.
 */

function player(userId: string, role: string, faction: Faction): PlayerState {
  return {
    userId, originalRole: role, currentRole: role,
    baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0,
    actualFaction: faction, treatedAsFaction: faction,
    alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {},
  };
}

function makeState(players: PlayerState[]): MatchState {
  const map: Record<string, PlayerState> = {};
  for (const p of players) map[p.userId] = p;
  return { matchId: "sim", dayCount: 1, phase: "night", angelCount: 0, demonCount: 0, modifiers: {}, players: map, actionStack: [] };
}

type NightAct = { src: string; actionType: string; target: string | null };
const NIGHT_PRIORITY: Record<string, number> = {
  seika_supernova: 1, phantom_seal: 1, logen_nullify: 1,
  doctor_heal: 3, mizlet_revive: 3, helen_revive: 3, arthur_emberblade: 3,
  demon_kill: 4,
};

function runNight(state: MatchState, acts: NightAct[]) {
  state.actionStack = acts.map((a) => ({
    sourceUserId: a.src, targetUserId: a.target, actionType: a.actionType,
    priority: NIGHT_PRIORITY[a.actionType] ?? 5,
  }));
  const { newState } = resolveNightActions(state);
  state.players = newState.players;
  state.actionStack = [];
}

// 낮 투표 + (후보 있으면) 찬반 처형. phase-advance 의 처형/보호막 로직 미러.
function runDayVote(
  state: MatchState,
  votes: Array<{ actor: string; target: string | null }>,
  verdicts: Array<{ actor: string; approve: boolean }>,
) {
  const tally = tallyEliminationVotes(votes.map((v) => ({ actorUserId: v.actor, targetUserId: v.target })), state.players);
  if (!tally.candidateUserId) return { executed: false }; // 부결/동률
  const verdict = tallyVerdictVotes(
    verdicts.map((v) => ({ actorUserId: v.actor, targetUserId: null, actionType: v.approve ? "verdict_approve" : "verdict_reject" })),
    state.players,
  );
  if (!verdict.approved) return { executed: false };
  const cand = state.players[tally.candidateUserId];
  if (!cand?.alive) return { executed: false };
  if ((cand.counters?.shield ?? 0) > 0) { cand.counters.shield -= 1; return { executed: false, blocked: true }; }
  cand.alive = false;
  return { executed: true, who: cand.userId };
}

const winnerOf = (state: MatchState) => checkWinCondition(state.players).winner;

// ===== 시나리오 1: 천사 승리 — 악마+조력자를 처형으로 전멸 =====
{
  const s = makeState([
    player("d", "demon", "demon"),
    player("h", "gain", "demon"),
    player("a1", "citizen", "angel"),
    player("a2", "doctor", "angel"),
    player("a3", "romaz", "angel"),
  ]);
  // 첫째 밤: 무능력(스킵). 승자 없음.
  assert.equal(winnerOf(s), null, "첫 밤 직후 승자 없음");
  // 1일차: 마을이 악마(d) 처형.
  runDayVote(s, [{ actor: "a1", target: "d" }, { actor: "a2", target: "d" }, { actor: "a3", target: "d" }], [
    { actor: "a1", approve: true }, { actor: "a2", approve: true }, { actor: "a3", approve: true },
  ]);
  assert.equal(s.players.d.alive, false, "악마 처형됨");
  assert.equal(winnerOf(s), null, "조력자 생존 → 아직 천사승 아님");
  // 2일차: 조력자(h) 처형 → 악마팀 전멸.
  runDayVote(s, [{ actor: "a1", target: "h" }, { actor: "a2", target: "h" }, { actor: "a3", target: "h" }], [
    { actor: "a1", approve: true }, { actor: "a2", approve: true }, { actor: "a3", approve: true },
  ]);
  assert.equal(winnerOf(s), "angels", "악마팀 전멸 → 천사 승리");
}

// ===== 시나리오 2: 악마 승리 — 밤 살해로 카운트 패리티 =====
{
  const s = makeState([
    player("d", "demon", "demon"),
    player("h", "gain", "demon"),
    player("a1", "citizen", "angel"),
    player("a2", "citizen", "angel"),
    player("a3", "citizen", "angel"),
  ]);
  // 1일차 투표 부결(동률) 가정.
  const r = runDayVote(s, [{ actor: "a1", target: "a2" }, { actor: "a2", target: "a1" }], [], );
  assert.equal(r.executed, false, "동률 → 부결");
  // 2일차 밤: 악마가 a1 처치.
  runNight(s, [{ src: "d", actionType: "demon_kill", target: "a1" }]);
  assert.equal(s.players.a1.alive, false, "야간 처치");
  // 생존: d,h(악마팀 2) vs a2,a3(천사 2) → demonCount>=angelCount → 악마 승리.
  assert.equal(winnerOf(s), "demons", "카운트 패리티 → 악마 승리");
}

// ===== 시나리오 3: 중립(파스아) 승리 — 누적 전향 3 (천사/악마보다 우선) =====
{
  const s = makeState([
    player("p", "pasua", "neutral"),
    player("d", "demon", "demon"),
    player("a1", "citizen", "angel"),
    player("a2", "citizen", "angel"),
    player("a3", "citizen", "angel"),
    player("a4", "citizen", "angel"),
  ]);
  // 파스아가 3밤에 걸쳐 a1,a2,a3 전향(악마는 idle). 전향마다 천사 수 감소.
  runNight(s, [{ src: "p", actionType: "pasua_convert", target: "a1" }]);
  assert.equal(winnerOf(s), null, "전향 1 — 아직 승자 없음");
  runNight(s, [{ src: "p", actionType: "pasua_convert", target: "a2" }]);
  assert.equal(winnerOf(s), null, "전향 2 — 아직 승자 없음");
  runNight(s, [{ src: "p", actionType: "pasua_convert", target: "a3" }]);
  // 전향 3 달성 시점에 demonCount(1)>=angelCount(1) 도 성립하지만 파스아 우선 → 중립 승리.
  assert.equal(s.players.a3.currentRole, "converted", "a3 전향");
  assert.equal(winnerOf(s), "neutral", "전향 3 + 파스아 생존 → 중립 단독 승리(우선)");
}

// ===== 시나리오 4: 최대 일수 안전망 — 우세 판정 (M2-5, P0-B 교착 방지) =====
{
  const s = makeState([
    player("d", "demon", "demon"),
    player("h", "gain", "demon"),
    player("a1", "citizen", "angel"),
    player("a2", "citizen", "angel"),
    player("a3", "citizen", "angel"),
  ]);
  // 천사 3 vs 악마팀 2 — 시간 초과 시 천사 우세.
  assert.equal(checkTimeoutWinner(s.players).winner, "angels", "카운트 우세 = 천사");
  // 동률(2:2)은 악마 — canon §30 충돌 시 악마 유리.
  s.players.a3.alive = false;
  assert.equal(checkTimeoutWinner(s.players).winner, "demons", "동률은 악마 유리");
  // 카운트 보너스(라이너 백호 등)가 우세 판정에 반영된다.
  s.players.a2.counters.countBonus = 2;
  assert.equal(checkTimeoutWinner(s.players).winner, "angels", "countBonus 반영");
}

console.log("Gomdori 풀게임 e2e 시뮬 (천사/악마/중립 승리 경로 + 타임아웃 우세) passed");

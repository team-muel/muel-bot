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

// ===== 시나리오 1: 천사 승리 — 악마 본체 처형 즉시(조력자 잔존 무관) =====
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
  // 1일차: 마을이 악마 본체(d) 처형.
  runDayVote(s, [{ actor: "a1", target: "d" }, { actor: "a2", target: "d" }, { actor: "a3", target: "d" }], [
    { actor: "a1", approve: true }, { actor: "a2", approve: true }, { actor: "a3", approve: true },
  ]);
  assert.equal(s.players.d.alive, false, "악마 본체 처형됨");
  // 새 canon: 악마 본체(처치자)가 죽으면 조력자(가인 h)가 살아 있어도 즉시 악마 진영 패배 →
  // 천사 승리. (조력자만 남은 무한 교착 차단 — 악마/조력자 구분의 존재 이유.)
  assert.equal(s.players.h.alive, true, "조력자(가인)는 아직 생존");
  assert.equal(winnerOf(s), "angels", "악마 본체 전멸 → 조력자 잔존과 무관하게 즉시 천사 승리");
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

// ===== 시나리오 3: 중립(파스아) 승리 — 파스아 팀 4명(원문, 천사/악마보다 우선) =====
// 원문: 포교는 2회 제한(maxUses 2) + 전향 대상 사망 시 1회 충전, 승리는 '파스아 팀(교주 + 전향자)
// 4명 이상'. 포교 2회로는 생존 전향자 2명(팀 3)까지만 — 팀 4는 더 긴 게임의 누적 결과다. 여기서는
// 승리 *조건*(팀 4 → 중립 우선승)과 maxUses 게이트(3회째 거부)를 함께 검증한다.
{
  const s = makeState([
    player("p", "pasua", "neutral"),
    player("d", "demon", "demon"),
    player("a1", "citizen", "angel"),
    player("a2", "citizen", "angel"),
    player("a3", "citizen", "angel"),
    player("a4", "citizen", "angel"),
  ]);
  // 포교 2회: a1, a2 전향(악마 idle). 팀 = 교주 + 전향 2 = 3 < 4 → 아직 승자 없음.
  runNight(s, [{ src: "p", actionType: "pasua_convert", target: "a1" }]);
  assert.equal(winnerOf(s), null, "전향 1(팀 2) — 아직 승자 없음");
  runNight(s, [{ src: "p", actionType: "pasua_convert", target: "a2" }]);
  assert.equal(s.players.a2.currentRole, "converted", "a2 전향(포교 2회째)");
  assert.equal(winnerOf(s), null, "전향 2(팀 3) — 임계(4) 미달, 승자 없음");
  // 3회째 포교는 maxUses 2 로 거부 — a3 는 전향되지 않는다(원문 '2회 제한').
  runNight(s, [{ src: "p", actionType: "pasua_convert", target: "a3" }]);
  assert.notEqual(s.players.a3.currentRole, "converted", "3회째 포교 — maxUses 거부(전향 안 됨)");
  assert.equal(winnerOf(s), null, "포교 한계 — 팀 3 유지, 중립 승리 없음");
  // 승리 조건 검증: 전향자 1명을 더 주입해 팀 4(교주 + 전향 3) → 중립 우선승.
  s.players.a3.currentRole = "converted";
  s.players.a3.actualFaction = "neutral";
  s.players.a3.treatedAsFaction = "neutral";
  assert.equal(winnerOf(s), "neutral", "파스아 팀 4(교주 + 전향 3) → 중립 단독 승리(우선)");
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

// ===== 시나리오 5: 미즐렛 고급 와인 — 투표가치 -1 은 1일 한정(다음 처형 1회 후 해제) =====
// 회귀: 예전엔 영속 voteValueMod 로 깔려 전원 0 → 처형 영구 봉인(교착). 이제 wineVotePenalty
// (날짜 스코프)로 그 처형 투표 1회만 적용되고 phase-advance 가 소비한다.
{
  const s = makeState([
    player("m", "mizlet", "angel"),
    player("a1", "citizen", "angel"),
    player("a2", "citizen", "angel"),
    player("d", "demon", "demon"),
  ]);
  // canon 〔지정〕 단일 대상 — a1(미디저트) 지정 → a1 만 페널티(a2 정상).
  runNight(s, [{ src: "m", actionType: "mizlet_wine", target: "a1" }]);
  assert.equal(s.players.a1.counters.wineVotePenalty, 1, "와인: 미디저트 대상(a1) 1일 페널티 부여");
  const t1 = tallyEliminationVotes(
    [{ actorUserId: "a1", targetUserId: "d" }],
    s.players,
  );
  assert.equal(t1.skipped, 1, "와인 적용일: 대상 a1 투표가치 0 → 무효(skipped)");
  assert.equal(t1.tallies["d"] ?? 0, 0, "a1 표 0표");
  // phase-advance 가 처형 투표 tally 직후 wineVotePenalty 소비 — 여기선 수동 클리어로 미러.
  for (const p of Object.values(s.players)) p.counters.wineVotePenalty = 0;
  const t2 = tallyEliminationVotes(
    [{ actorUserId: "a1", targetUserId: "d" }],
    s.players,
  );
  assert.equal(t2.tallies["d"], 1, "다음 날: 페널티 해제 → a1 표 정상(1)");
}

console.log("Gomdori 풀게임 e2e 시뮬 (천사/악마/중립 승리 경로 + 타임아웃 우세 + 와인 1일 페널티) passed");

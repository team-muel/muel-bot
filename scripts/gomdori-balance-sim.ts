/**
 * Gomdori 밸런스 몬테카를로 시뮬 (roadmap M6-2).
 *
 * 실제 엔진 프리미티브(resolveNightActions / tally* / checkWinCondition /
 * resolveNightmares)와 phase-advance 의 전이 순서를 in-memory 로 미러링해
 * N 판을 자동 플레이아웃한다. 목적은 **구조 진단 — degenerate 탐지**:
 * 인원수별 진영 승률 붕괴 / 무한게임 / 즉승 / 능력의 구조적 폭주.
 *
 * 정책(의사결정)은 "uninformed baseline": 투표·능력 대상은 합법 범위 내 균등
 * 랜덤. 악마팀만 서로(서클)를 알고 회피한다(실전과 동일한 정보 우위). 따라서
 * 여기 승률은 *실플레이 밸런스*가 아니라 **구조 기울기**다 — 추리(정보)가 0일 때
 * 시스템이 어느 쪽으로 미는가. 추리 실력은 천사에게만 가산되므로, 실전 천사
 * 승률은 baseline 보다 항상 높다. (결정 잠금 #5: 시뮬은 진단까지, 튜닝은 후속.)
 *
 * 실행:
 *   npm run sim:balance                      # 기본 N=2000, seed=42
 *   npx tsx scripts/gomdori-balance-sim.ts --n 5000 --seed 7 --approve 0.65
 *
 * 미러 출처(드리프트 시 함께 갱신):
 * - 로스터/카운터: match-start generateRoles + engineStateForAssignment,
 *   phase-advance finalizeRoleSelection(가인→악마 보호막 1).
 * - 전이: phase-advance — 첫째 밤 무능력 → 낮/투표/찬반(처형은 보호막 차단 가능)
 *   → night_suspect(최다 의심 = 그 밤 능력 봉인) → 밤 → 아침 악몽 해소 → 일식.
 * - 우선순위: phase-advance actionStack priority 매핑.
 */

import {
  checkTimeoutWinner,
  checkWinCondition,
  resolveNightActions,
  resolveNightmares,
  tallyEliminationVotes,
  tallySuspicionVotes,
  tallyVerdictVotes,
  TAG_SUSPECTED,
} from "../supabase/functions/_shared/engine/engine.ts";
import {
  ANGEL_ROLES,
  DEMON_KILLER_ROLES,
  HELPER_ROLES,
  isDemonKillerRole,
} from "../supabase/functions/_shared/engine/roles.ts";
import { GOMDORI_RULES } from "../supabase/functions/_shared/gomdori-rules.ts";
import type { Faction, MatchState, PlayerState } from "../supabase/functions/_shared/engine/types.ts";

// ===== 시드 RNG (mulberry32) — 재현 가능한 판 =====
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const shuffle = <T>(rng: Rng, arr: T[]): T[] => {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ===== 로스터 생성 — match-start.generateRoles 미러 =====
function makePlayer(userId: string, role: string, faction: Faction): PlayerState {
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

function buildRoster(rng: Rng, playerCount: number, spawnPasua: boolean): PlayerState[] {
  const players: PlayerState[] = [];
  // 변종은 실게임에선 본인 선택 — baseline 은 풀 균등(미선택 폴백과 동일 분포).
  players.push(makePlayer("demon", pick(rng, DEMON_KILLER_ROLES), "demon"));
  players.push(makePlayer("helper", pick(rng, HELPER_ROLES), "demon"));
  if (spawnPasua) players.push(makePlayer("pasua", "pasua", "neutral"));
  const angelSlots = playerCount - players.length;
  shuffle(rng, [...ANGEL_ROLES])
    .slice(0, angelSlots)
    .forEach((role, i) => players.push(makePlayer(`a${i}`, role, "angel")));

  // 배정 시 카운터 주입 — match-start engineStateForAssignment 미러.
  for (const p of players) {
    if (p.currentRole === "rainer") {
      p.counters.countBonus = 1;
      p.counters.deadCountBonus = 1;
    }
    if (p.currentRole === "uno") p.counters.countBonus = 1;
    if (p.currentRole === "arthur") p.counters.shield = 1;
  }
  // 가인(조력자)→악마 보호막 1 — phase-advance finalizeRoleSelection 미러.
  const helper = players.find((p) => p.userId === "helper")!;
  if (helper.currentRole === "gain") {
    const demon = players.find((p) => p.userId === "demon")!;
    if (!((demon.counters.shield ?? 0) > 0)) demon.counters.shield = 1;
  }
  return shuffle(rng, players);
}

function makeState(players: PlayerState[]): MatchState {
  const map: Record<string, PlayerState> = {};
  for (const p of players) map[p.userId] = p;
  return {
    matchId: "sim",
    dayCount: 1,
    phase: "night",
    angelCount: 0,
    demonCount: 0,
    modifiers: {},
    players: map,
    actionStack: [],
  };
}

// ===== phase-advance 의 priority 매핑 미러 =====
function priorityOf(actionType: string): number {
  if (["seika_supernova", "phantom_seal", "logen_nullify", "malen_possess", "besto_shift"].includes(actionType)) return 1;
  if (["demon_kill", "phantom_nightmare", "malen_release", "besto_hidden"].includes(actionType)) return 4;
  if (["doctor_heal", "mizlet_revive", "helen_revive", "arthur_emberblade"].includes(actionType)) return 3;
  return 5;
}

// ===== 정책 (uninformed baseline) =====
const alive = (s: MatchState) => Object.values(s.players).filter((p) => p.alive);
const dead = (s: MatchState) => Object.values(s.players).filter((p) => !p.alive);
const demonBucket = (p: PlayerState) => p.actualFaction === "demon" || p.actualFaction === "helper";

type Act = { src: string; actionType: string; target: string | null };

function nightPolicy(rng: Rng, s: MatchState, eclipseUsed: { v: boolean }, round: number): Act[] {
  const acts: Act[] = [];
  const living = alive(s);
  const circle = new Set(living.filter(demonBucket).map((p) => p.userId));
  const nonCircle = living.filter((p) => !circle.has(p.userId));
  const randNonCircle = () => (nonCircle.length ? pick(rng, nonCircle).userId : null);
  const randOther = (self: string) => {
    const pool = living.filter((p) => p.userId !== self);
    return pool.length ? pick(rng, pool).userId : null;
  };

  for (const p of living) {
    const role = p.currentRole;
    // 악마 처치자 — 서클 회피(악마팀은 서로를 안다).
    if (role === "demon") {
      acts.push({ src: p.userId, actionType: "demon_kill", target: randNonCircle() });
      if (rng() < 0.25) acts.push({ src: p.userId, actionType: "daeakma_brand", target: randNonCircle() });
    } else if (role === "phantom") {
      acts.push({ src: p.userId, actionType: "phantom_nightmare", target: randNonCircle() });
      if (rng() < 0.5) acts.push({ src: p.userId, actionType: "phantom_seal", target: randNonCircle() });
      if (!eclipseUsed.v && round >= 3 && rng() < 0.07) {
        acts.push({ src: p.userId, actionType: "phantom_eclipse", target: null });
        eclipseUsed.v = true;
      }
    } else if (role === "malen") {
      acts.push({ src: p.userId, actionType: "malen_release", target: randNonCircle() });
      if (rng() < 0.5) acts.push({ src: p.userId, actionType: "malen_possess", target: randNonCircle() });
    } else if (role === "besto") {
      acts.push({ src: p.userId, actionType: "besto_hidden", target: randNonCircle() });
      if (rng() < 0.3) acts.push({ src: p.userId, actionType: "besto_shift", target: p.userId });
    } else if (role === "luna") {
      acts.push({ src: p.userId, actionType: "luna_corrupt", target: randNonCircle() });
    } else if (role === "logen") {
      acts.push({ src: p.userId, actionType: "logen_nullify", target: randNonCircle() });
    } else if (role === "ellen") {
      acts.push({ src: p.userId, actionType: "ellen_persecute", target: randNonCircle() });
    } else if (role === "doctor" || role === "habreterus") {
      acts.push({ src: p.userId, actionType: "doctor_heal", target: pick(rng, living).userId });
    } else if (role === "arthur") {
      acts.push({ src: p.userId, actionType: "arthur_emberblade", target: pick(rng, living).userId });
    } else if (role === "mizlet" || role === "helen") {
      const d = dead(s);
      if (d.length) acts.push({ src: p.userId, actionType: role === "mizlet" ? "mizlet_revive" : "helen_revive", target: pick(rng, d).userId });
    } else if (role === "seika") {
      acts.push({ src: p.userId, actionType: "seika_supernova", target: randOther(p.userId) });
    } else if (role === "romaz") {
      acts.push({ src: p.userId, actionType: "romaz_suspect", target: randOther(p.userId) });
    } else if (role === "uno") {
      acts.push({ src: p.userId, actionType: "uno_struggle", target: randOther(p.userId) });
    } else if (role === "luru") {
      acts.push({ src: p.userId, actionType: "luru_charm", target: randOther(p.userId) });
    } else if (role === "pasua") {
      const eligible = living.filter(
        (t) => !isDemonKillerRole(t.currentRole) && t.currentRole !== "pasua" && t.currentRole !== "converted" && t.actualFaction !== "neutral",
      );
      if (eligible.length) acts.push({ src: p.userId, actionType: "pasua_convert", target: pick(rng, eligible).userId });
    }
    // dordan/police 조사·citizen·gain·rainer·converted·corrupted: 시뮬 효과 없음.
  }
  return acts;
}

// ===== 한 판 =====
type GameResult = {
  winner: "angels" | "demons" | "neutral";
  timeout: boolean;
  rounds: number;
  executions: number;
  nightDeaths: number;
  corrupts: number;
  converts: number;
  revives: number;
};

/**
 * 파스아 승리 규칙 후보 (P0-C 비교 측정 — --rule 로 선택).
 * - fixed3: 구 규칙 — 누적 전향 3 (생사 무관).
 * - scale: 임계 인원 비례 max(3, ceil(N/3)) — 8~9인 3, 10~12인 4.
 * - alive3: 생존 교세만 카운트(임계 3) — 전향자 처형이 카운터플레이가 된다.
 * - scale-alive: 둘 다 — **2026-06-11 채택, 엔진 현행**(engine.pasuaWinThreshold +
 *   생존 교세). 비교 측정 결과는 docs/gomdori-gameplay-verification.md §6.
 * 래퍼는 자체 규칙을 먼저 판정하고, 엔진의 neutral 판정은 무시(null 매핑)하므로
 * 엔진 현행보다 느슨한/엄격한 규칙 모두 측정 가능.
 */
type PasuaRule = "fixed3" | "scale" | "alive3" | "scale-alive";

function pasuaThreshold(rule: PasuaRule, totalPlayers: number): number {
  return rule === "scale" || rule === "scale-alive" ? Math.max(3, Math.ceil(totalPlayers / 3)) : 3;
}

function pasuaFlock(rule: PasuaRule, players: Record<string, PlayerState>): number {
  const converted = Object.values(players).filter((p) => p.currentRole === "converted");
  return (rule === "alive3" || rule === "scale-alive"
    ? converted.filter((p) => p.alive)
    : converted
  ).length;
}

function playGame(
  rng: Rng,
  playerCount: number,
  spawnPasua: boolean,
  approveP: number,
  pasuaRule: PasuaRule,
): GameResult {
  const s = makeState(buildRoster(rng, playerCount, spawnPasua));
  const eclipseUsed = { v: false };
  let executions = 0;
  let nightDeaths = 0;
  let revives = 0;
  let rounds = 0;
  let skipDay = false; // 일식: 다음 아침/투표 생략

  const win = (): GameResult["winner"] | null => {
    const w = checkWinCondition(s.players);
    const pasuaAlive = Object.values(s.players).some((p) => p.currentRole === "pasua" && p.alive);
    if (pasuaAlive && pasuaFlock(pasuaRule, s.players) >= pasuaThreshold(pasuaRule, playerCount)) {
      return "neutral";
    }
    // 엔진(현행 fixed3)은 neutral 이라 판단해도 후보 규칙 미달이면 계속 진행.
    if (w.winner === "neutral") return null;
    return w.winner;
  };
  const MAX_DAYS = GOMDORI_RULES.gameLength.maxDays;

  // 첫째 밤은 무능력(GOMDORI_RULES.firstNight) — 바로 1일차 낮으로.
  for (let round = 1; round <= MAX_DAYS; round++) {
    rounds = round;

    // --- 낮: 처형 투표 → 찬반 → 처형 (일식이면 생략) ---
    if (!skipDay) {
      const living = alive(s);
      const circle = new Set(living.filter(demonBucket).map((p) => p.userId));
      const votes = living.map((p) => {
        // 악마팀은 서클 회피, 그 외 균등 랜덤.
        const pool = living.filter((t) => t.userId !== p.userId && !(circle.has(p.userId) && circle.has(t.userId)));
        return { actorUserId: p.userId, targetUserId: pool.length ? pick(rng, pool).userId : null };
      });
      const tally = tallyEliminationVotes(votes, s.players);
      if (tally.candidateUserId) {
        const verdicts = alive(s).map((p) => ({
          actorUserId: p.userId,
          targetUserId: null,
          actionType: rng() < approveP ? "verdict_approve" : "verdict_reject",
        }));
        const verdict = tallyVerdictVotes(verdicts, s.players);
        const cand = s.players[tally.candidateUserId];
        if (verdict.approved && cand?.alive) {
          if ((cand.counters.shield ?? 0) > 0) {
            cand.counters.shield -= 1; // 처형 차단 — phase-advance 미러
          } else {
            cand.alive = false;
            executions++;
          }
        }
      }
      if (win()) break;
    }
    skipDay = false;

    // --- 밤 의심 투표 (둘째 밤부터 = 매 라운드): 최다 의심자 능력 봉인 ---
    {
      const living = alive(s);
      const suspicion = tallySuspicionVotes(
        living.map((p) => {
          const pool = living.filter((t) => t.userId !== p.userId);
          return { actorUserId: p.userId, targetUserId: pool.length ? pick(rng, pool).userId : null };
        }),
        s.players,
      );
      if (suspicion.candidateUserId) {
        const t = s.players[suspicion.candidateUserId];
        if (t?.alive && !t.tags.includes(TAG_SUSPECTED)) t.tags.push(TAG_SUSPECTED);
      }
    }

    // --- 밤: 능력 해소 ---
    const beforeAlive = alive(s).length;
    const beforeDead = dead(s).map((p) => p.userId);
    s.actionStack = nightPolicy(rng, s, eclipseUsed, round).map((a) => ({
      sourceUserId: a.src,
      targetUserId: a.target,
      actionType: a.actionType,
      priority: priorityOf(a.actionType),
    }));
    const { newState } = resolveNightActions(s);
    s.players = newState.players;
    s.actionStack = [];
    revives += beforeDead.filter((id) => s.players[id].alive).length;

    // --- 아침: 악몽 해소 (보호로 막히지 않음) → 일식 ---
    resolveNightmares(s.players);
    for (const p of Object.values(s.players)) {
      if (p.alive && (p.counters.eclipse ?? 0) > 0) {
        p.counters.eclipse = 0;
        p.alive = false; // 일식 소멸 — phase-advance eclipse_annihilation 미러
        skipDay = true;
      }
    }
    nightDeaths += Math.max(0, beforeAlive - alive(s).length);
    if (win()) break;
  }

  // 승부 미결 = 최대 일수 도달 → 우세 판정 (phase-advance 의 M2-5 안전망 미러).
  const w = win();
  const timeout = w == null;
  const winner = (w ?? checkTimeoutWinner(s.players).winner) as GameResult["winner"];
  const corrupts = Object.values(s.players).filter((p) => p.currentRole === "corrupted").length;
  const converts = Object.values(s.players).filter((p) => p.currentRole === "converted").length;
  return {
    winner,
    timeout,
    rounds,
    executions,
    nightDeaths,
    corrupts,
    converts,
    revives,
  };
}

// ===== 실행/집계 =====
function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const N = arg("n", 2000);
const SEED = arg("seed", 42);
const APPROVE_P = arg("approve", 0.5);
const PASUA_RULE = argStr("rule", "scale-alive") as PasuaRule; // 기본 = 엔진 현행

// 실시간 페이싱(룰 매니페스트 durations): 1라운드 = 의심30+밤60+해소3+낮180+투표60+찬반60 ≈ 6.6분.
const ROUND_MIN = (30 + 60 + 3 + 180 + 60 + 60) / 60;

console.log(
  `Gomdori 밸런스 몬테카를로 — N=${N}/구성, seed=${SEED}, 찬성확률=${APPROVE_P}, 파스아규칙=${PASUA_RULE} (uninformed baseline)`,
);
console.log(`구조 진단 전용 — 실플레이 승률 아님 (추리 정보 0 가정, 악마만 서클 인지)\n`);

const header = ["구성", "천사승", "악마승", "중립승", "캡종결", "평균일수", "p90일수", "예상실시간", "처형/판", "밤사망/판", "타락/판", "전향/판", "부활/판"];
const rows: string[][] = [];

// 인원 범위는 원본 기준 8~12 (gomdori-rules.playerCount, 사용자 확정 2026-06-11).
const COUNTS: number[] = [];
for (let c = GOMDORI_RULES.playerCount.min; c <= GOMDORI_RULES.playerCount.max; c++) COUNTS.push(c);

for (const playerCount of COUNTS) {
  for (const pasua of [false, true]) {
    const rng = mulberry32(SEED * 1000 + playerCount * 10 + (pasua ? 1 : 0));
    const results: GameResult[] = [];
    for (let i = 0; i < N; i++) results.push(playGame(rng, playerCount, pasua, APPROVE_P, PASUA_RULE));

    const count = (w: GameResult["winner"]) => results.filter((r) => r.winner === w).length;
    const pct = (n: number) => `${((100 * n) / N).toFixed(1)}%`;
    const avg = (f: (r: GameResult) => number) => results.reduce((a, r) => a + f(r), 0) / N;
    const sortedRounds = results.map((r) => r.rounds).sort((a, b) => a - b);
    const p90 = sortedRounds[Math.floor(N * 0.9)];

    rows.push([
      `${playerCount}인${pasua ? "+파스아" : ""}`,
      pct(count("angels")),
      pct(count("demons")),
      pct(count("neutral")),
      pct(results.filter((r) => r.timeout).length),
      avg((r) => r.rounds).toFixed(1),
      String(p90),
      `${Math.round(avg((r) => r.rounds) * ROUND_MIN + 5)}분`,
      avg((r) => r.executions).toFixed(1),
      avg((r) => r.nightDeaths).toFixed(1),
      avg((r) => r.corrupts).toFixed(2),
      avg((r) => r.converts).toFixed(2),
      avg((r) => r.revives).toFixed(2),
    ]);
  }
}

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => c.padStart(widths[i])).join("  ");
console.log(fmt(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(fmt(r));

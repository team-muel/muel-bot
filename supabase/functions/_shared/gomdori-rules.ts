/**
 * Gomdori 마피아 룰 매니페스트 — 게임 진행 상수의 single source of truth.
 *
 * frontend (muel-tree/src/config/gomdori-rules.ts) 와 동일한 형상으로 유지.
 * 모노레포가 아니므로 명시적 sync 정책: 한쪽 변경 시 다른 쪽 PR 동시 갱신.
 *
 * 관련:
 * - vault: [[Universes/BoW/Lore/Gomdori-마피아-규칙]]
 * - ADR-001: BoW Activity Architecture (§ 2 게임 진행 모델)
 */

export const GOMDORI_RULES = {
  /**
   * 각 페이즈 기본 duration (초). pg_cron + phase-advance Edge Function 이
   * `match_phases.expected_ended_at` 기준으로 만료 감지.
   */
  phases: {
    // 2026-06-15 페이스 단축(사용자 피드백 "특정 구간이 너무 길다"). 변종 선택은
    // 4지선다라 12초면 충분(미선택은 랜덤 폴백). 밤 20초, 의심·투표 10초.
    roleAssign: { durationSec: 12 },
    nightSuspect: { durationSec: 10 },
    // 상호추리(하브레터스↔악마) 전용 페이즈 — 하브 생존 시에만 끼어드는 시스템 구간.
    // 페이스 프리셋 영향 밖(고정), 지목 두 명만 행동하므로 짧게.
    nightDeduce: { durationSec: 15 },
    night: { durationSec: 20 },
    nightResolve: { durationSec: 3 },
    day: { durationSec: 180 },
    vote: { durationSec: 10 },
    verdict: { durationSec: 60 },
  },

  /**
   * 페이스(게임 시간) — 사전 게임 설정에서 호스트가 정한다(하드코딩 아님).
   * settings.pace = { preset?: PacePreset, overrides?: { [phase]: 초 } }.
   * backend(phase-advance/match-start)와 frontend(로비 미리보기)가 동일하게
   * resolvePhaseDurations 로 해소한다 — 단일 출처.
   *
   * 모델:
   * - tunablePhases: 사람이 체감하는 시간 구간. roleAssign(배정)·nightResolve(처리)는
   *   시스템 진행 구간이라 프리셋/오버라이드 밖(항상 기본값 고정).
   * - presets[*].scale: tunable 페이즈의 기본 duration 에 곱하는 배수(5초 단위 반올림).
   *   standard(=1.0)는 기존 동작을 그대로 재현한다(회귀 없음).
   * - clamp[phase]: 스케일/오버라이드 결과를 강제하는 안전 구간 [min,max] 초
   *   (0초 페이즈·무한 토론 방지). 고급 오버라이드도 이 범위로 클램프된다.
   */
  pace: {
    // firstNight 은 능력 비활성 안내 구간 — 페이스 영향 받지 않는 시스템 페이즈.
    tunablePhases: ["nightSuspect", "night", "day", "vote", "verdict"],
    defaultPreset: "standard",
    presets: {
      blitz: { label: "빠르게", detail: "짧고 빠른 한 판", scale: 0.6 },
      standard: { label: "표준", detail: "기본 호흡", scale: 1.0 },
      relaxed: { label: "느긋", detail: "충분한 토론", scale: 1.6 },
    },
    clamp: {
      nightSuspect: { min: 5, max: 30 },
      night: { min: 15, max: 90 },
      day: { min: 60, max: 600 },
      vote: { min: 5, max: 30 },
      verdict: { min: 15, max: 120 },
    },
  },

  /**
   * 첫째 밤 (phase_number === 1) 룰 — vault canon §34.
   *
   * 직업 배정 → silent first night (8초 안내) → 아침 → 밤 → ...
   * skipsAbilities=true: 정보 누적 전 첫 능력으로 결판나는 것 방지 — 첫 밤은
   * 능력 X, phase-advance 는 곧장 day1 로 넘긴다. 페이스 설정과 무관(고정 8초).
   */
  firstNight: {
    skipsAbilities: true,
    durationSec: 8,
  },

  /**
   * 승리 조건.
   * - angels: 살아있는 악마 0명
   * - demons: 살아있는 악마 수 ≥ 살아있는 천사 수
   */
  winConditions: {
    angels: "aliveDemons === 0",
    demons: "aliveDemons >= aliveAngels",
  },

  /**
   * 인원 범위 — 원본 기준 8~12 (사용자 확정 2026-06-11: "5인 게임은 의도한 결과
   * 아님, 원본은 8~12"). match-start 검증과 로비 시작 조건의 단일 출처.
   * 중립(파스아) 등장 자격(PASUA_MIN_PLAYERS=8)과 최소 인원이 일치한다 —
   * 모든 유효 게임에서 중립이 등장할 *수* 있다(auto 확률은 game.ts
   * NEUTRAL_SPAWN_CHANCE).
   */
  playerCount: {
    min: 8,
    max: 12,
  },

  /**
   * 게임 길이 안전망 (M2-5 교착 방지).
   * maxDays 일차의 판결까지 승부가 나지 않으면 다음 밤으로 넘어가지 않고
   * 우세 판정(팀 카운트 비교, 동률은 악마 — canon §30 충돌 시 악마 유리)으로 종착.
   * 근거: docs/gomdori-gameplay-verification.md P0-B (부활 루프 교착).
   */
  gameLength: {
    maxDays: 15,
  },
} as const;

export type GomdoriRules = typeof GOMDORI_RULES;

// --- 페이스(게임 시간) 해소 — backend/frontend 공용 순수 함수 ---

export type PhaseDurationKey =
  | "roleAssign"
  | "nightSuspect"
  | "nightDeduce"
  | "night"
  | "nightResolve"
  | "day"
  | "vote"
  | "verdict"
  | "firstNight";

export type PhaseDurations = Record<PhaseDurationKey, number>;

export type PacePreset = keyof typeof GOMDORI_RULES.pace.presets;

export const PACE_PRESETS = GOMDORI_RULES.pace.presets;

// 각 페이즈의 기본 duration(초) — manifest 단일 출처에서 평탄화.
export const PACE_BASE_DURATIONS: PhaseDurations = {
  roleAssign: GOMDORI_RULES.phases.roleAssign.durationSec,
  nightSuspect: GOMDORI_RULES.phases.nightSuspect.durationSec,
  nightDeduce: GOMDORI_RULES.phases.nightDeduce.durationSec,
  night: GOMDORI_RULES.phases.night.durationSec,
  nightResolve: GOMDORI_RULES.phases.nightResolve.durationSec,
  day: GOMDORI_RULES.phases.day.durationSec,
  vote: GOMDORI_RULES.phases.vote.durationSec,
  verdict: GOMDORI_RULES.phases.verdict.durationSec,
  firstNight: GOMDORI_RULES.firstNight.durationSec,
};

function round5(n: number): number {
  return Math.max(5, Math.round(n / 5) * 5);
}

function clampPhaseDuration(key: string, value: number): number {
  const clamp = (GOMDORI_RULES.pace.clamp as Record<string, { min: number; max: number }>)[key];
  if (!clamp) return value; // 고정 페이즈(roleAssign/nightResolve)는 클램프 없음
  return Math.min(clamp.max, Math.max(clamp.min, value));
}

/** settings.pace.preset 을 안전하게 해소(미지정/오타 → defaultPreset). */
export function resolvePacePreset(settings: Record<string, unknown>): PacePreset {
  const pace = settings?.pace;
  const raw = pace && typeof pace === "object" ? (pace as { preset?: unknown }).preset : undefined;
  if (typeof raw === "string" && raw in GOMDORI_RULES.pace.presets) {
    return raw as PacePreset;
  }
  return GOMDORI_RULES.pace.defaultPreset;
}

/**
 * settings 로부터 모든 페이즈의 실제 duration(초)을 해소한다.
 * 우선순위: 페이즈별 오버라이드(있으면) > 프리셋 스케일 > 기본값. 결과는 항상 clamp 범위.
 * pace 미설정이면 standard 프리셋 = 기존 동작 그대로(회귀 없음).
 */
export function resolvePhaseDurations(settings: Record<string, unknown>): PhaseDurations {
  const preset = resolvePacePreset(settings);
  const scale = GOMDORI_RULES.pace.presets[preset].scale;
  const pace = settings?.pace && typeof settings.pace === "object"
    ? (settings.pace as { overrides?: unknown })
    : {};
  const overrides = pace.overrides && typeof pace.overrides === "object"
    ? (pace.overrides as Record<string, unknown>)
    : {};
  const tunable = GOMDORI_RULES.pace.tunablePhases as readonly string[];

  const out: PhaseDurations = { ...PACE_BASE_DURATIONS };
  for (const key of tunable) {
    const k = key as PhaseDurationKey;
    let value = round5(PACE_BASE_DURATIONS[k] * scale);
    const override = overrides[key];
    if (typeof override === "number" && Number.isFinite(override)) {
      value = Math.round(override);
    }
    out[k] = clampPhaseDuration(key, value);
  }
  return out;
}

export type PaceSettings = {
  preset?: PacePreset;
  overrides?: Partial<Record<string, number>>;
};

/**
 * 들어온 pace 입력을 매니페스트 기준으로 정제한다(임의 키/값 주입 방지).
 * - preset: 유효 프리셋만 통과.
 * - overrides: tunable 페이즈 키 + 유한수만, clamp 범위로 강제.
 * 정제 결과가 비면 {} (= standard 기본) 를 돌려준다.
 */
export function sanitizePaceSettings(input: unknown): PaceSettings {
  const out: PaceSettings = {};
  if (!input || typeof input !== "object") return out;
  const raw = input as { preset?: unknown; overrides?: unknown };

  if (typeof raw.preset === "string" && raw.preset in GOMDORI_RULES.pace.presets) {
    out.preset = raw.preset as PacePreset;
  }

  if (raw.overrides && typeof raw.overrides === "object") {
    const tunable = GOMDORI_RULES.pace.tunablePhases as readonly string[];
    const src = raw.overrides as Record<string, unknown>;
    const cleaned: Record<string, number> = {};
    for (const key of tunable) {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        cleaned[key] = clampPhaseDuration(key, Math.round(v));
      }
    }
    if (Object.keys(cleaned).length > 0) out.overrides = cleaned;
  }

  return out;
}

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
    roleAssign: { durationSec: 8 },
    nightSuspect: { durationSec: 30 },
    night: { durationSec: 60 },
    nightResolve: { durationSec: 3 },
    day: { durationSec: 180 },
    vote: { durationSec: 60 },
    verdict: { durationSec: 60 },
  },

  /**
   * 첫째 밤 (phase_number === 1) 룰.
   *
   * BoW Gomdori 마피아 규칙:
   * - 직업 배정 → 첫 밤 → 아침. 첫 밤은 모든 능력 비활성.
   * - 이유: 시민 정보 누적 전에 첫 능력으로 게임 결판나는 것 방지.
   * - 첫 밤 duration 은 짧음 (안내성).
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
} as const;

export type GomdoriRules = typeof GOMDORI_RULES;

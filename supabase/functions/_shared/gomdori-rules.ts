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

  /**
   * 중립(파스아) 등장 정책 (결정 잠금 #2 — 확률 등장).
   * - minPlayers: 등장 자격 최소 인원 (중립은 천사 슬롯 1을 대체하므로 큰 게임에서만).
   * - autoSpawnChance: 모드 "auto"(기본)에서의 등장 확률 — 참여자는 존재 여부를 알 수 없다.
   *   호스트는 로비 설정(match-settings)으로 "on"/"off" 강제 가능.
   *   확률값은 밸런스 후속 결정 대상(잠금 #5) — `npm run sim:balance` 로 비교 측정 후 조정.
   */
  neutral: {
    minPlayers: 8,
    autoSpawnChance: 1 / 3,
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

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
    night: { durationSec: 20 },
    nightResolve: { durationSec: 3 },
    day: { durationSec: 180 },
    vote: { durationSec: 10 },
    verdict: { durationSec: 60 },
  },

  /**
   * 첫째 밤 (phase_number === 1) 룰.
   *
   * 2026-06-15 설계 변경(사용자 결정): 첫 밤도 일반 밤처럼 능력 사용 가능.
   * "배정 직후 밤은 능력 없음"이 아니라 첫 밤부터 대악마 처치 등이 돌아야 한다.
   * skipsAbilities=false → phase-advance 가 night1 을 정상 해소(능력 발동), duration 은
   * 일반 밤과 동일(60초)로 행동 시간 확보. (구: silent 8초 안내성 밤.)
   */
  firstNight: {
    skipsAbilities: false,
    durationSec: 20,
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

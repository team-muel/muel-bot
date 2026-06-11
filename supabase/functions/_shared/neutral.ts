import { GOMDORI_RULES } from "./gomdori-rules.ts";

/**
 * 중립(파스아) 등장 정책 — 서버 단일 출처 (결정 잠금 #2: 확률 등장).
 *
 * muel-tree `src/lib/game/api.ts` 의 resolveNeutralMode 와 동일 규칙을 서버에서
 * 구현한다(클라이언트는 표시용, 서버가 판정 권위). 모드:
 * - "auto"(기본): 자격 인원에서 GOMDORI_RULES.neutral.autoSpawnChance 확률로 등장 —
 *   참여자는 존재 여부를 알 수 없다.
 * - "on": 자격 인원이면 항상 등장 (호스트 강제).
 * - "off": 등장하지 않음 (호스트 강제).
 * 자격: playerCount >= GOMDORI_RULES.neutral.minPlayers (중립은 천사 슬롯 1 대체).
 */

export type NeutralMode = "auto" | "on" | "off";

export const NEUTRAL_MODES: readonly NeutralMode[] = ["auto", "on", "off"];

export function resolveNeutralMode(settings: Record<string, unknown>): NeutralMode {
  const raw = settings.neutral;
  if (typeof raw === "string" && (NEUTRAL_MODES as readonly string[]).includes(raw)) {
    return raw as NeutralMode;
  }
  // 레거시 불리언(includeNeutral) 호환 — match-settings 도입 전 형식.
  if (settings.includeNeutral === true) return "on";
  if (settings.includeNeutral === false) return "off";
  return "auto";
}

/** match-start 가 호출하는 등장 판정. random 주입은 테스트/시뮬용. */
export function rollNeutralSpawn(
  settings: Record<string, unknown>,
  playerCount: number,
  random: () => number = Math.random,
): boolean {
  if (playerCount < GOMDORI_RULES.neutral.minPlayers) return false;
  const mode = resolveNeutralMode(settings);
  if (mode === "on") return true;
  if (mode === "off") return false;
  return random() < GOMDORI_RULES.neutral.autoSpawnChance;
}

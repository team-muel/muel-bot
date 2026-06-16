import type { PhaseDurations } from "./gomdori-rules.ts";

export const PHASE_NIGHT = "night";
export const PHASE_NIGHT_SUSPECT = "night_suspect";

export type PhaseTransition = {
  phaseType: string;
  phaseNumber: number;
  durationSec: number;
};

// duration 은 더 이상 manifest 기본값을 직접 읽지 않는다 — 호출부가 settings 로부터
// resolvePhaseDurations 로 해소한 durations 를 넘긴다(페이스 설정 단일 출처).
export function firstNightTransition(durations: PhaseDurations): PhaseTransition {
  return {
    phaseType: PHASE_NIGHT,
    phaseNumber: 1,
    durationSec: durations.firstNight,
  };
}

export function nextNightSuspectTransition(
  currentPhaseNumber: number,
  durations: PhaseDurations,
): PhaseTransition {
  return {
    phaseType: PHASE_NIGHT_SUSPECT,
    phaseNumber: currentPhaseNumber + 1,
    durationSec: durations.nightSuspect,
  };
}

export function nightAfterSuspicionTransition(
  phaseNumber: number,
  durations: PhaseDurations,
): PhaseTransition {
  return {
    phaseType: PHASE_NIGHT,
    phaseNumber,
    durationSec: durations.night,
  };
}

import { GOMDORI_RULES } from "./gomdori-rules.ts";

export const PHASE_NIGHT = "night";
export const PHASE_NIGHT_SUSPECT = "night_suspect";

export type PhaseTransition = {
  phaseType: string;
  phaseNumber: number;
  durationSec: number;
};

export function firstNightTransition(): PhaseTransition {
  return {
    phaseType: PHASE_NIGHT,
    phaseNumber: 1,
    durationSec: GOMDORI_RULES.firstNight.durationSec,
  };
}

export function nextNightSuspectTransition(currentPhaseNumber: number): PhaseTransition {
  return {
    phaseType: PHASE_NIGHT_SUSPECT,
    phaseNumber: currentPhaseNumber + 1,
    durationSec: GOMDORI_RULES.phases.nightSuspect.durationSec,
  };
}

export function nightAfterSuspicionTransition(phaseNumber: number): PhaseTransition {
  return {
    phaseType: PHASE_NIGHT,
    phaseNumber,
    durationSec: GOMDORI_RULES.phases.night.durationSec,
  };
}

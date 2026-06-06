import type { Effect, MatchState, PlayerState } from "./types.ts";
import { CORE_ROLES } from "./roles.ts";

const TAG_PROTECTED = "protected";
const TAG_DELAYED = "delayed";

export type VoteActionInput = {
  actorUserId: string;
  targetUserId: string | null;
  actionType?: string;
};

export type VoteTallyResult = {
  tallies: Record<string, number>;
  skipped: number;
  candidateUserId: string | null;
  maxVotes: number;
  tie: boolean;
};

export type VerdictTallyResult = {
  approve: number;
  reject: number;
  skipped: number;
  approved: boolean;
};

export type WinConditionResult = {
  winner: "angels" | "demons" | null;
  aliveAngels: number;
  aliveDemons: number;
};

export function getRoleDefinition(roleId: string) {
  return CORE_ROLES.find((role) => role.id === roleId);
}

export function resolveNightActions(state: MatchState): { newState: MatchState; events: unknown[] } {
  const newState: MatchState = JSON.parse(JSON.stringify(state));
  const events: unknown[] = [];

  const sortedActions = [...newState.actionStack].sort((a, b) => a.priority - b.priority);
  newState.actionStack = [];

  for (const action of sortedActions) {
    const sourcePlayer = newState.players[action.sourceUserId];
    const targetPlayer = action.targetUserId ? newState.players[action.targetUserId] : null;

    if (!sourcePlayer?.alive) continue;

    const roleDef = getRoleDefinition(sourcePlayer.currentRole);
    if (!roleDef) continue;

    const ability = roleDef.actions.night?.find((candidate) => candidate.id === action.actionType);
    if (!ability) continue;

    if (sourcePlayer.tags.includes(TAG_DELAYED)) {
      sourcePlayer.tags = sourcePlayer.tags.filter((tag) => tag !== TAG_DELAYED);
      events.push({ type: "action_delayed", userId: sourcePlayer.userId });
      continue;
    }

    for (const effect of ability.effects) {
      let target: PlayerState | null = null;
      if (effect.target === "self") target = sourcePlayer;
      if (effect.target === "Target" && targetPlayer) target = targetPlayer;

      if (!target) continue;
      if (!target.alive && ability.targetType !== "SINGLE_DEAD") continue;

      applyEffect(newState, sourcePlayer, target, effect, events);
    }
  }

  for (const userId in newState.players) {
    const player = newState.players[userId];

    if (player.markedForDeath) {
      if (player.tags.includes(TAG_PROTECTED)) {
        player.markedForDeath = false;
        player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED);
        events.push({ type: "attack_prevented", userId: player.userId });
      } else {
        player.alive = false;
        player.markedForDeath = false;
        events.push({ type: "player_died", payload: { user_id: player.userId } });
      }
    }

    player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED && tag !== TAG_DELAYED);
  }

  return { newState, events };
}

export function tallyEliminationVotes(
  actions: VoteActionInput[],
  players: Record<string, PlayerState>,
): VoteTallyResult {
  const tallies: Record<string, number> = {};
  let skipped = 0;

  for (const action of actions) {
    const actor = players[action.actorUserId];
    if (!actor?.alive) continue;

    if (!action.targetUserId) {
      skipped += 1;
      continue;
    }

    const target = players[action.targetUserId];
    if (!target?.alive) {
      skipped += 1;
      continue;
    }

    const voteValue = Math.max(0, (actor.baseVoteValue || 1) + (actor.bonusVoteValue || 0));
    if (voteValue === 0) {
      skipped += 1;
      continue;
    }

    tallies[action.targetUserId] = (tallies[action.targetUserId] || 0) + voteValue;
  }

  let candidateUserId: string | null = null;
  let maxVotes = 0;
  let tie = false;

  for (const [targetUserId, votes] of Object.entries(tallies)) {
    if (votes > maxVotes) {
      candidateUserId = targetUserId;
      maxVotes = votes;
      tie = false;
    } else if (votes === maxVotes) {
      tie = true;
    }
  }

  return {
    tallies,
    skipped,
    candidateUserId: tie ? null : candidateUserId,
    maxVotes,
    tie,
  };
}

export function tallyVerdictVotes(actions: VoteActionInput[], players: Record<string, PlayerState>): VerdictTallyResult {
  let approve = 0;
  let reject = 0;
  let skipped = 0;

  for (const action of actions) {
    const actor = players[action.actorUserId];
    if (!actor?.alive) continue;

    const voteValue = Math.max(0, (actor.baseVoteValue || 1) + (actor.bonusVoteValue || 0));
    if (voteValue === 0) {
      skipped += 1;
      continue;
    }

    if (action.actionType === "verdict_approve") {
      approve += voteValue;
    } else if (action.actionType === "verdict_reject") {
      reject += voteValue;
    } else {
      skipped += 1;
    }
  }

  return {
    approve,
    reject,
    skipped,
    approved: approve > reject,
  };
}

// 카운트 기반 승리 판정 (canon §1·§10).
// 천사 승리 = 살아있는 악마 0 (탈락/처형). 악마 승리 = 악마팀 카운트 >= 천사팀 카운트.
// 기본 카운트: 생존자 = 1, 사망자 = 0. counters.countBonus(생존 가산, 예: 수호병 +1)
// 와 counters.deadCountBonus(사망 무관 지속, 예: 라이너 백호 +3) 가 팀 카운트에 반영된다.
// 능력이 카운트를 건드리지 않으면(counters 비어있음) 결과는 생존 패리티와 동일 — 회귀 0.
export function checkWinCondition(players: Record<string, PlayerState>): WinConditionResult {
  let aliveAngels = 0;
  let aliveDemons = 0;
  let angelCount = 0;
  let demonCount = 0;

  for (const player of Object.values(players)) {
    const faction = player.treatedAsFaction || player.actualFaction;
    const bucket =
      faction === "demon" || faction === "helper"
        ? "demon"
        : faction === "angel"
          ? "angel"
          : null;
    if (!bucket) continue;

    if (player.alive) {
      const weight = 1 + (player.counters?.countBonus ?? 0);
      if (bucket === "demon") {
        aliveDemons += 1;
        demonCount += weight;
      } else {
        aliveAngels += 1;
        angelCount += weight;
      }
    } else {
      const deadWeight = player.counters?.deadCountBonus ?? 0;
      if (deadWeight) {
        if (bucket === "demon") demonCount += deadWeight;
        else angelCount += deadWeight;
      }
    }
  }

  let winner: "angels" | "demons" | null = null;
  if (aliveDemons === 0) {
    winner = "angels";
  } else if (demonCount >= angelCount) {
    winner = "demons";
  }

  return { winner, aliveAngels, aliveDemons };
}

function applyEffect(
  _state: MatchState,
  _source: PlayerState,
  target: PlayerState,
  effect: Effect,
  events: unknown[],
) {
  switch (effect.type) {
    case "Kill":
      target.markedForDeath = true;
      break;
    case "Heal":
      if (!target.alive) {
        target.alive = true;
        events.push({ type: "player_revived", payload: { user_id: target.userId } });
      }
      break;
    case "Protect":
      target.tags.push(TAG_PROTECTED);
      break;
    case "AddTag":
      if (effect.tag) target.tags.push(effect.tag);
      break;
    case "RemoveTag":
      if (effect.tag) {
        target.tags = target.tags.filter((tag) => tag !== effect.tag);
      }
      break;
    case "ChangeFaction":
      if (target.actualFaction !== "demon" && target.actualFaction !== "neutral") {
        target.actualFaction = "neutral";
        target.currentRole = "converted";
        events.push({ type: "faction_changed", payload: { user_id: target.userId, new_faction: "neutral" } });
      }
      break;
  }
}

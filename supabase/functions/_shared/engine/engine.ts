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

export function checkWinCondition(players: Record<string, PlayerState>): WinConditionResult {
  let aliveAngels = 0;
  let aliveDemons = 0;

  for (const player of Object.values(players)) {
    if (!player.alive) continue;

    const faction = player.treatedAsFaction || player.actualFaction;
    if (faction === "demon" || faction === "helper") {
      aliveDemons += 1;
    } else if (faction === "angel") {
      aliveAngels += 1;
    }
  }

  let winner: "angels" | "demons" | null = null;
  if (aliveDemons === 0) {
    winner = "angels";
  } else if (aliveDemons >= aliveAngels) {
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

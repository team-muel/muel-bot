export type Faction = "angel" | "demon" | "helper" | "neutral";

export interface PlayerState {
  userId: string;
  originalRole: string;
  currentRole: string;
  
  baseVoteValue: number;
  bonusVoteValue: number;
  suspicionValue: number;

  actualFaction: Faction;
  treatedAsFaction: Faction | null;
  
  alive: boolean;
  markedForDeath: boolean;
  markedForAnnihilation: boolean; // 소멸
  tags: string[];
  counters: Record<string, number>;
}

export interface MatchState {
  matchId: string;
  dayCount: number;
  phase: "role_assign" | "night" | "day" | "vote" | "verdict" | "ended";
  angelCount: number;
  demonCount: number;
  players: Record<string, PlayerState>;
  actionStack: ActionPayload[];
  modifiers: Record<string, number>;
}

export interface ActionPayload {
  sourceUserId: string;
  targetUserId: string | null;
  actionType: string; // e.g., "demon_kill", "doctor_heal"
  priority: number;
}

export interface Effect {
  // Silence(봉인): 대상의 그 밤 능력 발동을 막는다. 봉인 액션은 priority 를 가장 낮게(=먼저)
  //   둬서, 대상의 능력보다 앞서 resolveNightActions 에서 처리되도록 한다(세이카/팬텀).
  type: "ModifyVoteValue" | "ModifyReceivedVote" | "ModifyReceivedSuspicion" | "AddTag" | "RemoveTag" | "Kill" | "Annihilate" | "Heal" | "Protect" | "RevealRole" | "ChangeFaction" | "Silence";
  target: "self" | "Target" | "All";
  amount?: number;
  tag?: string;
  duration?: "1_NIGHT" | "1_DAY" | "PERMANENT";
}

export interface PassiveAbility {
  trigger: "ON_NIGHT_START" | "ON_DAY_START" | "ON_VOTE_CAST" | "ON_DEATH_ATTEMPT";
  condition?: string; // string evaluated condition, or we can use code for Phase 1
  effects: Effect[];
}

export interface ActiveAbility {
  id: string;
  name: string;
  targetType: "SINGLE_ALIVE" | "SINGLE_DEAD" | "SELF" | "ALL" | "NONE";
  priority: number;
  effects: Effect[];
  maxUses?: number;
}

export interface RoleDefinition {
  id: string;
  name: string;
  faction: Faction;
  passives: PassiveAbility[];
  actions: {
    night?: ActiveAbility[];
    day?: ActiveAbility[];
  };
}

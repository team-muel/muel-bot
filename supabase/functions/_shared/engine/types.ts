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
  // Corrupt(루나 공포 속에 밀어 넣다): 천사를 악마팀으로 타락(currentRole='corrupted',
  //   actualFaction='demon'). ChangeFaction 이 중립화(파스아)인 것과 대칭.
  // GrantCount(우노 투쟁): 대상의 소속 카운트(counters.countBonus)를 amount 만큼 더한다(지속).
  // Charm(루루 매료): 대상의 다음 처형 투표를 무력화(counters.charmed, 라운드 한정)하고,
  //   그 투표 권한을 루루에게 양도(루루 counters.voteWeightBonus +1, 지속).
  // Nightmare(팬텀 악몽): 지연 탈락 — counters.nightmare 누적. 밤 보호로 못 막고, 아침
  //   해소(resolveNightmares)에서 탈락. 재적용 시 영면(나중 단계).
  // Possess(말렌 빙의): 대상 그 밤 행동 봉인(silencedNights) + 그 라운드 악마팀으로 카운트
  //   (counters.possessed, 라운드 한정 — checkWinCondition 이 demon 버킷으로 셈).
  // Disguise(베스토 변신): self 토글 — counters.disguised(0 하베스토→악마 판정 / 1 솔→조사 시 천사).
  // Rebrand(대악마 낙인): 대상의 currentRole 을 임의의 천사 직업으로 재배정(직업 삭제→비밀 재배정).
  // Eclipse(팬텀 일식): self.counters.eclipse=1 — phase-advance 가 다음 아침을 밤으로 바꾸고 팬텀 소멸.
  type: "ModifyVoteValue" | "ModifyReceivedVote" | "ModifyReceivedSuspicion" | "AddTag" | "RemoveTag" | "Kill" | "Annihilate" | "Heal" | "Protect" | "RevealRole" | "ChangeFaction" | "Silence" | "Corrupt" | "GrantCount" | "Charm" | "Nightmare" | "Possess" | "Disguise" | "Rebrand" | "Eclipse";
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

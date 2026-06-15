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
  // 투표/의심 대상 기억(substrate) — 직전 처형 투표·의심 투표에서 이 플레이어가 지목한
  // 대상. phase-advance 가 집계 시 matches.engine_state 에 맵으로 기록하고
  // playerStateFromRows 가 복원한다. Effect.target "VoteTarget"/"SuspectTarget" 이 참조
  // (루나 달빛·엘런 박해·도르단 범인 등 "내가 투표/의심한 대상" 능력의 단일 토대).
  lastVoteTarget?: string | null;
  lastSuspectTarget?: string | null;
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
  // Cleanse(세이카 초신성·우노 사명): 대상의 라운드성/지연 부정 효과를 모두 제거(지속 자석·마크 제외).
  // Haunt(말렌 혼령 방출 다단계): 1회차 → 혼령 표식(haunted). 2회차(표식 보유) → 영에게 잠식
  //   = 탈락 + 대상의 투표가치를 말렌에게 조공(source.voteWeightBonus +1). 표식 소비.
  type: "ModifyVoteValue" | "ModifyReceivedVote" | "ModifyReceivedSuspicion" | "AddTag" | "RemoveTag" | "Kill" | "Annihilate" | "Heal" | "Protect" | "RevealRole" | "ChangeFaction" | "Silence" | "Corrupt" | "GrantCount" | "Charm" | "Nightmare" | "Possess" | "Disguise" | "Rebrand" | "Eclipse" | "Cleanse" | "Sleep" | "Nullify" | "Haunt";
  // VoteTarget/SuspectTarget: source 가 직전에 투표/의심한 대상으로 해소(substrate).
  // AllOthers: source 를 제외한 생존자 전체(악마 "전원" 능력은 보통 자신 제외 — 사탄의 마·
  // 압도적 존재감). All 은 source 포함(천사 버프 등).
  target: "self" | "Target" | "All" | "AllOthers" | "VoteTarget" | "SuspectTarget";
  amount?: number;
  tag?: string;
  duration?: "1_NIGHT" | "1_DAY" | "PERMANENT";
  // Kill 면역 진영(파스아 신앙: 악마는 탈락하지 않는다). 대상 지정은 허용하되 해소
  // 시점에 actualFaction 이 목록에 들면 markedForDeath 를 세우지 않는다(클린 — 처치
  // 프리미티브 재사용, 직업 하드코딩 금지).
  immuneFactions?: Faction[];
  // 진영 게이트(아서 단죄 결백/타락 판정). 대상 actualFaction 이 이 목록에 없으면 이 효과
  // 자체를 건너뛴다(immuneFactions 의 역 — "해당 진영에만 적용"). 한 능력에 진영별로 다른
  // 효과를 붙여 분기(예: 단죄 = 악마팀이면 Annihilate / 천사·중립이면 Protect)한다.
  onlyFactions?: Faction[];
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
  // 자기 자신을 대상으로 지정할 수 없는 능력(처치·변환·박해 등). match-action 검증의
  // 단일 출처(ADR-006 S1) — 과거 KILL_LIKE/NO_SELF_TARGET 하드코딩을 대체한다.
  excludeSelf?: boolean;
  // 대상 직업/진영 제한(ADR-006 S2) — 파스아 포교·루나 타락 등 역할집합 기반 제한을
  // 선언형으로. match-action 이 제네릭하게 사전검증(엔진 applyEffect 도 이중 가드).
  // excludeRoleSets: 명명 집합("demonKiller"=처치자 풀, "helper"=조력자 풀).
  // excludeRoles: 유효 직업(currentRole) 직접 제외. excludeFactions: actualFaction 제외.
  targetFilter?: {
    excludeRoleSets?: ("demonKiller" | "helper")[];
    excludeRoles?: string[];
    excludeFactions?: Faction[];
    message?: string;
  };
  // 발동 전 카운터 게이트(루나 달 게이지·우노 1회성 등 재사용). min 미만이면 발동 차단,
  // consume 면 발동 후 0 으로 소비.
  requiresCounter?: { key: string; min: number; consume?: boolean };
  // 발동 성공 후 source 카운터 세팅(ADR-006 S3) — 파스아 연속 포교 쿨다운 등.
  // 과거 resolveNightActions 의 actionType 분기를 선언형으로 대체.
  onFireSetCounter?: { key: string; value: number };
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
  // 밤 탈락 발생 시 살아있는 이 직업이 카운터를 얻는 후크(ADR-006 S3) — 도르단 단서,
  // 말렌 혼/시체. 과거 resolveNightActions 의 currentRole 분기를 선언형으로 대체.
  // perDeath: 탈락 1명당 counter += amount. convert: from 이 threshold 이상이면 차감하고 to += amount.
  deathHook?: {
    perDeath: { counter: string; amount: number };
    convert?: { from: string; threshold: number; to: string; amount: number };
  };
}

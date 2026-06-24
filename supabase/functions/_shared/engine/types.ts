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
  // 멀티타깃 능력(아서 잔불이 꺼지기 전에=3명 지정). targetCount>1 인 능력에서 "Target" 효과를
  // 이 목록의 각 대상에 적용한다. 단일 대상 능력은 targetUserId 만 사용(하위호환).
  targetUserIds?: string[];
  actionType: string; // e.g., "demon_kill", "doctor_heal"
  priority: number;
}

export interface Effect {
  // Silence(봉인): 대상의 그 밤 능력 발동을 막는다. 봉인 액션은 priority 를 가장 낮게(=먼저)
  //   둬서, 대상의 능력보다 앞서 resolveNightActions 에서 처리되도록 한다(세이카/팬텀).
  // Corrupt(루나 공포 속에 밀어 넣다): 천사를 악마팀으로 타락(currentRole='corrupted',
  //   actualFaction='demon'). ChangeFaction 이 중립화(파스아)인 것과 대칭.
  // GrantCount(우노 투쟁): 대상의 소속 카운트(counters.countBonus)를 amount 만큼 더한다(지속).
  //   tag="missionCharge" 는 우노 군인의 사명 충전으로, 2개가 쌓이면 악마 효과 1회를 제거한다.
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
  // Verdict(아서 해오름 판정): 대상이 부정 효과를 적용한 적 있으면(counters.tainted) '타락',
  //   아니면 '결백'으로 시전자에게 통지. 진영이 아니라 행위 이력으로 가린다(vault 아서 §해오름).
  // DelaySilence(우노 명예 실추): 대상을 *다음* 밤 봉인(counters.silencePending → 다음 밤 시작에
  //   silencedNights 로 승격, 말렌 마비와 같은 지연 패턴 재사용). Silence(그 밤 한정)와 달리
  //   priority 타이밍에 의존하지 않는다 — 우노 용맹함은 priority 5 라 같은 밤 봉인이 불가능.
  // Absorb(세이카 자신만 아플 거야): 대상의 받은 부여 효과를 세이카가 흡수(대상은 정화=Cleanse,
  //   흡수량은 source.counters.absorbedDebuffs 누적). 누적 3+ 이면 세이카 소멸(markedForDeath +
  //   annihilated) + demonRevealIn 카운트다운 세팅(이틀 후 악마팀 공개). target:"All" 로 사용.
  // DelayAction(가인 약간의 위선): 대상의 *다음* 능력 발동을 한 밤 연기(counters.delayPending →
  //   다음 밤 시작에 TAG_DELAYED 로 승격). Nullify(소멸)와 달리 효과를 없애지 않고 미룬다.
  // Charge(루나 고요한 적막 비례 충전): 시전자(_source)의 counters[tag] 를 amount 만큼 올린다.
  //   단 해소된 대상이 악마(actualFaction='demon')면 demonAmount 를 쓴다(canon 달빛 +10%/악마 +30%).
  //   대상은 충전의 '기준'일 뿐 변경 대상이 아니다 — VoteTarget/SuspectTarget substrate 와 함께 쓴다.
  // Deduce(하브레터스 상호추리): 대상이 악마(처치자 풀)면 '적중' — 시전자 부정효과 정화(그 밤 악마
  //   효과 면역 근사) + deduce_hit. 빗나가면 deduce_miss. 악마측 역추리(하브 탈락)는 후속(양방향 서브게임).
  // SummonCorpse(말렌 신출귀몰): 혼령 표식(haunted)을 수거해 다음 밤 corpsePending → deadCountBonus
  //   로 시체를 소환한다. 시체는 현재 악마팀 사망 무관 카운트 보너스로 표현된다.
  type: "ModifyVoteValue" | "ModifyReceivedVote" | "ModifyReceivedSuspicion" | "AddTag" | "RemoveTag" | "Kill" | "Annihilate" | "Heal" | "Protect" | "RevealRole" | "ChangeFaction" | "Silence" | "Corrupt" | "GrantCount" | "Charm" | "Nightmare" | "Possess" | "Disguise" | "Rebrand" | "Eclipse" | "Cleanse" | "Sleep" | "Nullify" | "Haunt" | "Verdict" | "DelaySilence" | "Absorb" | "DelayAction" | "Charge" | "Deduce" | "SummonCorpse" | "VoteCrush";
  // Charge 전용: 대상이 악마일 때 쓰는 충전량(미지정 시 amount).
  demonAmount?: number;
  // 태그 게이트(미즐렛 고급 와인): 대상에게 tag 가 있으면(onlyIfTargetTag) / 없으면(skipIfTargetTag 는
  // 있으면 건너뜀) 적용. 진영/카운터 게이트의 태그 버전 — 한 능력에 디저트 유/무 분기를 붙인다.
  onlyIfTargetTag?: string;
  skipIfTargetTag?: string;
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
  // Kill 전용: 부활 불가 처치(로건 '전부 괜찮을 거야' 파멸 2중첩 소멸). markedForDeath 와 함께
  // counters.annihilated=1 을 세워 미즐렛/헬렌/소생 계열의 부활 게이트를 막는다(canon '소멸').
  annihilate?: boolean;
  // 진영 게이트(아서 단죄 결백/타락 판정). 대상 actualFaction 이 이 목록에 없으면 이 효과
  // 자체를 건너뛴다(immuneFactions 의 역 — "해당 진영에만 적용"). 한 능력에 진영별로 다른
  // 효과를 붙여 분기(예: 단죄 = 악마팀이면 Annihilate / 천사·중립이면 Protect)한다.
  onlyFactions?: Faction[];
  // 행위-기반 게이트(아서 잔불 대검 결백/타락 판정). 대상의 counters[key] 가 min 이상일 때만
  // 이 효과를 적용한다(onlyIfTargetCounter) / min 이상이면 건너뛴다(skipIfTargetCounter).
  // onlyFactions(진영 게이트)의 행위 버전 — '부정 효과 적용 이력(tainted)' 같은 누적 카운터로
  // 분기한다. 한 능력에 두 효과를 붙여 결백(skipIfTargetCounter)/타락(onlyIfTargetCounter) 분기.
  onlyIfTargetCounter?: { key: string; min: number };
  skipIfTargetCounter?: { key: string; min: number };
  // 시전자 카운터 게이트(가인 위선 전환): _source.counters[key] 로 분기. 한 능력에 두 효과를
  // 붙여 시전자 상태에 따라 다른 효과(예: 위선 = 평시 연기 / 전환후 처치)를 고른다.
  onlyIfSourceCounter?: { key: string; min: number };
  skipIfSourceCounter?: { key: string; min: number };
  // 홀수날 한정(엘런 박해자: 홀수날에만 발동). state.dayCount 가 홀수일 때만 적용한다.
  oddDayOnly?: boolean;
  // 자기 처벌(우노 명예 실추): 게이트(onlyFactions 등)는 *대상*으로 평가하되 효과는 *시전자*에게
  // 적용. "천사 투표 대상을 처형하면(=동료 살해) 우노 자신이 명예 실추(다음 밤 행동 불가)" 처럼
  // 대상의 속성에 따라 시전자가 벌받는 패턴. 현재 DelaySilence 에서 지원.
  selfPenalty?: boolean;
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
  // 멀티타깃 지정 수(아서 잔불이 꺼지기 전에=3). 미지정/1 이면 단일 대상. "Target" 효과를
  // ActionPayload.targetUserIds 의 각 대상에 적용한다. match-action 이 최대 개수를 검증한다.
  targetCount?: number;
  // 동적 멀티타깃 상한(팬텀 어둠이 내린 도시 = 매 아침 +1). 유효 상한 = targetCount(미지정 시 1)
  //   + targetCountPerDay*(dayCount-1) + (targetCountCounter ? source.counters[그 키] : 0).
  //   engine·match-action 둘 다 effectiveTargetCount() 로 계산해 일관 적용(직업 하드코딩 없음).
  targetCountPerDay?: number;
  targetCountCounter?: string;
  // 같은 대상 연속(직전 같은 능력 사용) 지목 금지(팬텀 어둠이 내린 도시). match-action 이 직전
  // 같은 action_type 제출의 대상과 겹치면 거부한다(직업 하드코딩 없이 플래그로).
  noConsecutiveTarget?: boolean;
  // 낮(day/vote/verdict)에도 발동 가능(팬텀 영면 발동 — 처형 시간에 쌓아둔 영면 일괄 처치).
  // match-action 이 낮 제출을 허용하고 즉시 처리한다(밤 제출은 기존 엔진 경로).
  usableInDay?: boolean;
  // '추억된' 탈락자 허용(헬렌 황금빛 수면, canon "영혼이 기억된 플레이어는 탈락 후에도 발동 가능").
  // targetType SINGLE_ALIVE 이어도 target 이 사망 상태이면서 'remembered' 태그를 보유하면
  // 대상 검증·엔진 적용 모두 통과. Sleep 적용 시 자동 부활(canon "수면으로 깨면 복귀").
  allowRememberedDead?: boolean;
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
  // consume 면 발동 후 0 으로 소비. consumeAmount 면 0 이 아니라 그만큼만 차감(아서 잔불 대검
  // 충전: 누적 충전을 1 씩 소비). consumeAmount 가 있으면 consume 보다 우선.
  requiresCounter?: { key: string; min: number; consume?: boolean; consumeAmount?: number };
  // 발동 성공 후 source 카운터 세팅(ADR-006 S3) — 파스아 연속 포교 쿨다운 등.
  // 과거 resolveNightActions 의 actionType 분기를 선언형으로 대체.
  onFireSetCounter?: { key: string; value: number };
  // 보호가 실제로 공격을 막았을 때(attack_prevented) 시전자에게 카운터 보상(하브레터스 소명:
  // 생명의 언약 성공 시 투표가치 +3). Protect 효과가 그 밤 실제 살해를 무효화한 경우에만 적용.
  onSaveGrantSelf?: { counter: string; amount: number };
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

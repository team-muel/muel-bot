import type { RoleDefinition } from "./types.ts";

export const CORE_ROLES: RoleDefinition[] = [
  {
    id: "citizen",
    name: "Citizen",
    faction: "angel",
    passives: [],
    actions: {},
  },
  {
    id: "doctor",
    name: "Doctor",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        {
          id: "doctor_heal",
          name: "Protect",
          targetType: "SINGLE_ALIVE",
          priority: 3,
          effects: [{ type: "Protect", target: "Target", duration: "1_NIGHT" }],
        },
      ],
    },
  },
  {
    id: "police",
    name: "Police",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        {
          id: "police_investigate",
          name: "Investigate",
          targetType: "SINGLE_ALIVE",
          priority: 5,
          effects: [],
        },
      ],
    },
  },
  {
    // 대악마(악마-1): 처치 + 메피스토 낙인(대상 직업 삭제→임의 천사 직업으로 비밀 재배정). vault [[대악마]].
    id: "demon",
    name: "대악마",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        {
          id: "demon_kill",
          name: "처치",
          targetType: "SINGLE_ALIVE",
          priority: 4,
          excludeSelf: true,
          // 사탄의 마(원문): 대악마가 *능력을 성공 발동시키면* 자신 제외 전원의 행사 투표가치 -1
          // (지속 누적, tally 의 voteValueMod). 원문은 처치뿐 아니라 모든 대악마 능력 성공 발동이
          // 트리거 — 그래서 demon_kill·낙인·압도적 존재감·역추리 각각에 동일 -1 효과를 붙인다(능력당
          // 1회). 기본 투표가치=1 이라 누적되면 전원 0 — 마을은 표로 악마를 처형할 수 없다(투표 독점).
          // 원문 "이 효과로 대상 투표가치가 0이 되면 그 대상의 조사·취급이 악마로 판정"의 *per-target*
          // 판정은 후속 — 현재는 천사팀 전원 0 → 전역 악마 취급(applySatanicRealm)으로 보수적 근사.
          // 감시(원문 만악의 근원): 발동 시 낙인 적용자(mephistoBrand 보유)가 존재하면 대악마 자신에게
          // voteCountBonus +1(다음 아침 2표) 부여 — 루루 무투와 같은 라이프사이클(phase-advance 가 처형
          // tally 직후 소비). onlyIfAnyPlayerTag 로 낙인 적용자 존재 시에만 발동. "같은 대상 2표 시 무조건
          // 반론"(강제 재심)은 verdict 반론 override 가 필요해 후속(루루 무투와 동일 blocker).
          effects: [
            { type: "Kill", target: "Target" },
            { type: "ModifyVoteValue", target: "AllOthers", amount: -1 },
            { type: "GrantCount", target: "self", tag: "voteCountBonus", amount: 1, onlyIfAnyPlayerTag: "mephistoBrand" },
          ],
        },
        // 낙인 — 원문 사탄의 마는 '능력 성공 발동'이 트리거이므로 낙인 성공에도 전원 -1 동반. AddTag
        // mephistoBrand: 낙인 적용자 표식(감시 게이트의 전역 조건) — '자기 직업 모르는 대상'의 backend 면.
        { id: "daeakma_brand", name: "메피스토 낙인", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [{ type: "Rebrand", target: "Target" }, { type: "AddTag", target: "Target", tag: "mephistoBrand" }, { type: "ModifyVoteValue", target: "AllOthers", amount: -1 }] },
        // 압도적 존재감(v2, 1회): 공포로 자신을 제외한 전원의 그 밤 능력을 봉인(Silence AllOthers
        // — 악마 자신은 영향 없음). priority 1 — 대상들 능력보다 먼저 봉인. 사탄의 마: 성공 시 전원 -1.
        { id: "daeakma_dominion", name: "압도적 존재감", targetType: "ALL", priority: 1, maxUses: 1, effects: [{ type: "Silence", target: "AllOthers" }, { type: "ModifyVoteValue", target: "AllOthers", amount: -1 }] },
        // 삶이 있는 곳으로(하브레터스, 악마 측 역추리): 대악마가 의심 가는 하브레터스를 지목.
        // 적중(target.currentRole==='habreterus')이면 하브 Annihilate(다음 처치, 치료 무시).
        // 빗나가면 통지만(deduce_miss). Deduce effect 가 source.actualFaction='demon' 분기로 동작.
        // priority 4 — 동일 라운드 doctor_heal(3) 후 처리되어 치료가 먼저 들어가지만 Annihilate 가
        // PROTECTED 를 우회(engine death loop 의 annihilated 게이트).
        { id: "demon_deduce", name: "역추리", targetType: "SINGLE_ALIVE", priority: 4, excludeSelf: true, effects: [{ type: "Deduce", target: "Target" }] },
      ],
    },
  },
  {
    id: "helper",
    name: "Helper",
    faction: "demon",
    passives: [],
    actions: {},
  },
  // --- W4 v1 트랜치 (canon §W4, 시그니처 한 줄만; 다단계는 v2) ---
  {
    // 라이너: 백호 패시브 = 천사팀 카운트 +3, 생존 무관.
    // 카운트는 counters(countBonus/deadCountBonus)로 표현 — 배정 시 주입(match-start).
    id: "rainer",
    name: "라이너",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        {
          // 백호 소환: 1회 self 액션 — 천사팀 카운트 +3(생존 가산) + +3(생존 무관 지속). canon 자석 +3.
          id: "rainer_summon",
          name: "백호 소환",
          targetType: "SELF",
          priority: 5,
          maxUses: 1,
          effects: [
            { type: "GrantCount", target: "self", amount: 3 },
            { type: "GrantCount", target: "self", amount: 3, tag: "deadCountBonus" },
          ],
        },
        // 강한 의지(v2, canon): 대상 관찰 + 시전자 willCount +1. 같은 대상 연속 지목 불가
        // (noConsecutiveTarget). 관찰 대상이 그 밤 탈락하면 라이너 deathHook 이 willCount +2
        // 추가(observedByRainer 표식 → engine 후처리). willCount 2 누적이 거친 포효 발동 트리거
        // 의 토대(거친 포효 자체는 후속 — 멀티타깃 markedForDeath + voteValueMod 게이트 복합).
        {
          id: "rainer_resolve",
          name: "강한 의지",
          targetType: "SINGLE_ALIVE",
          priority: 5,
          excludeSelf: true,
          noConsecutiveTarget: true,
          effects: [
            { type: "AddTag", target: "Target", tag: "observedByRainer" },
            { type: "GrantCount", target: "self", tag: "willCount", amount: 1 },
          ],
        },
        // 그날의 저항(v2, 1회, 첫 밤 불가): 백호 한 마리 추가 소환 — 즉시 deadCountBonus +1
        // (백호 추가 한 마리). 효과 종료 시 -1 + 강한 의지 +1 의 canon 단계는 후속 — 본 PR 은
        // 단순 1회 즉시 보너스로 근사. 첫 밤 차단은 gomdori-rules.firstNight.skipsAbilities 가 처리.
        {
          id: "rainer_resistance",
          name: "그날의 저항",
          targetType: "SELF",
          priority: 5,
          maxUses: 1,
          effects: [
            { type: "GrantCount", target: "self", amount: 1, tag: "deadCountBonus" },
            { type: "GrantCount", target: "self", amount: 1, tag: "willCount" },
          ],
        },
      ],
    },
  },
  {
    // 로마즈: 용의자 색출 = 대상에게 +5 투표가치 / +10 의심가치(받는-표 가산).
    id: "romaz",
    name: "로마즈",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        {
          id: "romaz_suspect",
          name: "용의자 색출",
          targetType: "SINGLE_ALIVE",
          priority: 5,
          effects: [
            { type: "ModifyReceivedVote", target: "Target", amount: 5 },
            { type: "ModifyReceivedSuspicion", target: "Target", amount: 10 },
          ],
        },
      ],
    },
  },
  {
    // 가인: 조력자(악마팀, 조사 시 천사로 보임). 악마에 보호막 부여(배정 시 주입).
    // 약간의 위선(원문 충실): "대상의 직업을 통지받고, 능력의 발동을 *취소*시킵니다. *악마가 대상을
    // 투표했었다면* 다음 발동하는 '약간의 위선'이 능력을 *봉인*시키는 효과로 강화됩니다." 매핑:
    // ① 대상 직업(진영) 통지 — 악마팀 정찰(match-action-core 가 investigationResult 로 즉시 반환).
    // ② 대상 그 밤 능력 *취소* = Silence(봉인 액션이 priority 1 → 대상 능력보다 먼저 처리, 그 밤만).
    // ③ 대상에 'hypocrisy' 표식(AddTag) — 밤 종료 시 engine 훅이 "악마가 그 대상을 투표했었나"
    //    (alive demon 의 lastVoteTarget === 대상)를 검사해 맞으면 생존 가인의 hypocrisySealReady 를
    //    켠다(강화 트리거 = 원문의 '악마가 대상을 투표했었다면'). ④ 강화 상태(hypocrisySealReady≥1)면
    //    평시 Silence 대신 tag 부착 Silence → 같은 대상 재적용 시 *영구 봉인*(원문 "봉인시키는 효과로
    //    강화"). 발동 후 onFireSetCounter 로 강화 소비(0).
    id: "gain",
    name: "가인",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        // priority 1 — 봉인(Silence)이 대상의 능력보다 먼저 처리돼 그 밤 발동을 *취소*한다(원문).
        { id: "gain_hypocrisy", name: "약간의 위선", targetType: "SINGLE_ALIVE", priority: 1, excludeSelf: true,
          onFireSetCounter: { key: "hypocrisySealReady", value: 0 },
          effects: [
            // 직업 통지(정찰) + 그 밤 능력 취소(Silence). hypocrisy 표식은 밤 종료 시 '악마 투표' 검사용.
            { type: "RevealRole", target: "Target" },
            { type: "AddTag", target: "Target", tag: "hypocrisy" },
            // 평시: 그 밤 능력 취소(Silence). 강화 상태면 봉인 강화(tag → 재적용 시 영구).
            { type: "Silence", target: "Target", skipIfSourceCounter: { key: "hypocrisySealReady", min: 1 } },
            { type: "Silence", target: "Target", tag: "hypocrisySeal", onlyIfSourceCounter: { key: "hypocrisySealReady", min: 1 } },
          ] },
        // 급습(v2, 1회): 대상 능력 통지 삭제(noticeSuppressed 표식 — 그 밤 한정, engine 아침 cleanup
        // 에서 제거) + 가인 raidCharge +1 충전(canon "급습 1회 충전"). 다음 아침까지 악마와 대화는
        // Discord 채팅 회로라 별도 후속 — 백엔드는 raid_initiated 이벤트로 신호만 발사한다.
        { id: "gain_raid", name: "급습", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, maxUses: 1,
          onFireSetCounter: { key: "raidCharge", value: 1 },
          effects: [{ type: "AddTag", target: "Target", tag: "noticeSuppressed" }] },
      ],
    },
  },
  // --- W6 v1 중립 (canon §1 중립, 특수 카테고리-4 파스아) ---
  {
    // 파스아: 사이비 교주(중립). 시그니처 = 포교(전향). 대상 1명을 전향시켜
    // 자기 진영(converted)으로 흡수. 파스아 팀 4명+ 시 단독 즉시 승리(checkWinCondition, 원문 구원자).
    // canon: 악마·중립 포교 불가 → 효과/검증에서 차단(천사 + 가인만 전향 가능).
    // v2: 포교(전향, 원문 "2회 제한 + 포교 대상 사망 시 1회 충전" = maxUses 2 + 전향자 사망 시
    // engine 훅이 used_pasua_convert 1 차감) + 신앙(대상 탈락, 악마 면역).
    id: "pasua",
    name: "파스아",
    faction: "neutral",
    passives: [],
    actions: {
      night: [
        {
          id: "pasua_convert",
          name: "포교",
          targetType: "SINGLE_ALIVE",
          priority: 5,
          excludeSelf: true,
          // 원문 "2회 제한" — maxUses 2(used_pasua_convert 로 추적). 전향자 사망 시 1회 충전(death hook).
          maxUses: 2,
          // 천사·조력자만 전향(악마 처치자·중립 불가). 엔진 ChangeFaction 도 이중 가드.
          targetFilter: { excludeRoleSets: ["demonKiller"], excludeRoles: ["pasua", "converted"], message: "악마와 중립은 포교할 수 없습니다." },
          effects: [{ type: "ChangeFaction", target: "Target" }],
        },
        {
          // 신앙: 대상 탈락(악마는 탈락 안 함, canon §파스아). Kill 재사용 + immuneFactions.
          id: "pasua_faith",
          name: "신앙",
          targetType: "SINGLE_ALIVE",
          priority: 4,
          excludeSelf: true,
          effects: [{ type: "Kill", target: "Target", immuneFactions: ["demon"] }],
        },
      ],
    },
  },
  {
    // 전향된 플레이어: 기존 승리조건 삭제 + 파스아의 승리를 따름. 능력 없음.
    // currentRole 이 'converted' 로 바뀌며, checkWinCondition 이 이를 파스아 교세로 카운트.
    id: "converted",
    name: "전향자",
    faction: "neutral",
    passives: [],
    actions: {},
  },
  {
    // 타락자(루나 변환): 천사 → 악마팀. 능력 없음. checkWinCondition 이 악마 카운트로 셈
    // (actualFaction='demon' 영속화). 본래 직업은 게임 종료 시 함께 공개(canon §9).
    id: "corrupted",
    name: "타락자",
    faction: "demon",
    passives: [],
    actions: {},
  },

  // === 기본 로스터 (canon "기본" 시트) — v1 시그니처를 기존 프리미티브에 매핑. ===
  // 고유 다단계 능력은 각 vault 카드 + v2. "시민(무직)" 폐지 — 전원 명명 직업.

  // --- 악마 풀 (1명 뽑힘): 전부 v1 처치. 'demon'(대악마)은 위 정의 재사용. ---
  {
    // 팬텀(악마-2): 악몽(지연 탈락 — 아침 탈락, 밤 보호 불가) + 어둠이 내린 도시(봉인, priority 1).
    // 팬텀의 처치 능력은 canon 상 '악몽'. demon_kill 대신 phantom_nightmare 를 처치자 능력으로.
    id: "phantom",
    name: "팬텀",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        // 악몽: 지정 → 다음 아침 탈락. 이미 악몽인 대상 재지정 = 영면(풀 누적, engine Nightmare case).
        // 지정 가능 수 = 1 + counters.deepsleepCount(살아있는 영면 1명당 +1) — 동적 멀티타깃.
        // 사용 횟수(nightmareUses) 풀: 5회 제한(match-start 5 주입). 발동 1회당 1 소비(1명이든 다수든
        // 한 발동=1 소비). 어둠이 내린 도시에서 0명 지목한 밤마다 +2 충전(상한 5, engine 아침 처리).
        { id: "phantom_nightmare", name: "악몽", targetType: "SINGLE_ALIVE", priority: 4, excludeSelf: true, targetCount: 1, targetCountCounter: "deepsleepCount", requiresCounter: { key: "nightmareUses", min: 1, consumeAmount: 1 }, effects: [{ type: "Nightmare", target: "Target" }] },
        // 영면 발동: 누적한 영면(deepsleep) 대상 전원을 일괄 처치. 기존 프리미티브 재사용 —
        // Kill(All) + onlyIfTargetCounter(deepsleep) 게이트로 영면자만 markedForDeath. 발동 후
        // deepsleepCount 0 리셋. 낮 처형 시간 즉시 발동은 match-action-core usableInDay 경로에서 처리.
        { id: "phantom_reap", name: "영면 발동", targetType: "NONE", priority: 4, usableInDay: true, effects: [{ type: "Kill", target: "All", onlyIfTargetCounter: { key: "deepsleep", min: 1 } }], onFireSetCounter: { key: "deepsleepCount", value: 0 } },
        // 침묵의 밤(패시브 능동화): 밤 종료 시 밤을 한 번 더 연다(악마팀 재행동). 대가 = 생존 천사팀
        // 소속 카운트 +1(GrantCount, onlyFactions angel — 천사팀 대응 여지) + 토론 +1분. extendNight
        // 표식을 phase-advance 가 읽어 다음 아침을 밤으로 전환 + 토론 가산(eclipse 유사, 소멸 없음).
        { id: "phantom_silentnight", name: "침묵의 밤", targetType: "NONE", priority: 5, effects: [{ type: "GrantCount", target: "All", amount: 1, onlyFactions: ["angel"] }], onFireSetCounter: { key: "extendNight", value: 1 } },
        // 어둠이 내린 도시(특수 패시브): 매 밤 천사팀 직업을 봉인(그 밤 한정 Silence). 지목 가능 수
        // = 2 + counters.sealCap. sealCap 은 밤 해소마다 +1 되어 다음 밤 봉인 상한을 키운다.
        // priority 1 — 대상 행동보다 먼저 봉인. '같은 대상 연속 지목 금지'와 '0명 지목 시
        // 악몽 +2' 도 match-action/engine 경로에서 검증·반영한다.
        { id: "phantom_seal", name: "어둠이 내린 도시", targetType: "SINGLE_ALIVE", priority: 1, excludeSelf: true, targetCount: 2, targetCountCounter: "sealCap", noConsecutiveTarget: true, effects: [{ type: "Silence", target: "Target" }] },
        { id: "phantom_eclipse", name: "일식", targetType: "SELF", priority: 5, maxUses: 1, effects: [{ type: "Eclipse", target: "self" }] },
      ],
    },
  },
  {
    // 말렌(악마-7): 혼령 방출(처치) + 빙의(그 밤 행동 봉인 + 악마팀 카운트 전환, priority 1)
    // + 신출귀몰(혼령 표식 수거→다음 밤 시체 소환).
    id: "malen",
    name: "말렌",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        // 혼령 방출(canon 다단계): 1회차 혼령 표식, 2회차(표식 보유)에 잠식=탈락+투표가치 조공(Haunt).
        { id: "malen_release", name: "혼령 방출", targetType: "SINGLE_ALIVE", priority: 4, excludeSelf: true, effects: [{ type: "Haunt", target: "Target" }] },
        { id: "malen_possess", name: "빙의", targetType: "SINGLE_ALIVE", priority: 1, excludeSelf: true, effects: [{ type: "Possess", target: "Target" }] },
        // 신출귀몰(v2, 1회): 무대의 혼령 표식을 수거해 다음 밤 시체를 소환한다. 시체는 현재
        // deadCountBonus(사망 무관 악마팀 카운트)로 표현한다.
        { id: "malen_elusive", name: "신출귀몰", targetType: "NONE", priority: 5, maxUses: 1, effects: [{ type: "SummonCorpse", target: "All" }] },
      ],
    },
    // 악담: 밤 탈락 1명당 혼 +1. 혼 2개 → 시체 1구(악마팀 카운트 deadCountBonus +1).
    deathHook: { perDeath: { counter: "soul", amount: 1 }, convert: { from: "soul", threshold: 2, to: "deadCountBonus", amount: 1 } },
  },
  {
    // 로잔느(악마-5, 세헤라자드): 독립 솔로(파스아식, 조력자 없음, faction neutral). v1 코어 —
    // 백일몽=7아침 생존 단독승(checkWinCondition + resolveNightActions dreamMorning 카운터),
    // 증오=처형(대상 투표가치 -1, 0 도달 즉시 처형 = VoteCrush), 만들어가는 미래(르상티망 약식)=
    // futureCharge 1 소비 + 대상 '원한' 표식 + 자기 dreamMorning +1(canon "아침이 한 번 더").
    // 라포르·외현기억·건너뛰기·조망(전역 시전비용)·받는가치+1 다운사이드·토론1분·무투불가 = v2.
    // 처치 풀(DEMON_KILLER_ROLES)에 없음 — match-start 가 besto 자리 대신 독립 스폰한다.
    id: "rosanne",
    name: "로잔느",
    faction: "neutral",
    passives: [],
    actions: {
      night: [
        { id: "rosanne_hatred", name: "증오", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [{ type: "VoteCrush", target: "Target" }] },
        { id: "rosanne_resentment", name: "만들어가는 미래", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, requiresCounter: { key: "futureCharge", min: 1, consumeAmount: 1 }, effects: [{ type: "AddTag", target: "Target", tag: "wonhan" }, { type: "GrantCount", target: "self", tag: "dreamMorning", amount: 1 }] },
        // 라포르(만들어가는 미래 변주, 2인 지정 — 처형·탈락·소멸을 공유). futureCharge 1 소비.
        { id: "rosanne_rapport", name: "라포르", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, targetCount: 2, requiresCounter: { key: "futureCharge", min: 1, consumeAmount: 1 }, effects: [{ type: "LinkFate", target: "Target" }] },
        // 외현기억(탈락자 1인 지정 — 다음 아침 부활 후 그 날 처형, 투표 재처형 시 효과 상실). futureCharge 1 소비.
        { id: "rosanne_manifest", name: "외현기억", targetType: "SINGLE_DEAD", priority: 5, excludeSelf: true, requiresCounter: { key: "futureCharge", min: 1, consumeAmount: 1 }, effects: [{ type: "Manifest", target: "Target" }] },
        // 건너뛰기(self, priority 0 = 최우선, 1회): 이 밤 발동한 다른 모든 효과를 취소(SkipNight).
        { id: "rosanne_skip", name: "건너뛰기", targetType: "SELF", priority: 0, maxUses: 1, effects: [{ type: "SkipNight", target: "self" }] },
      ],
    },
  },

  // --- 조력자 풀 (1명 뽑힘): 악마 회로 패시브. 가인(위 정의)만 보호막. ---
  {
    // 루나(조력자-5): 달의 사제 = 공포 속에 밀어 넣다(천사→악마팀 변환, v2). vault [[루나]].
    id: "luna",
    name: "루나",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        // 고요한 적막(v2 비례 충전): 투표·의심한 대상(substrate)에 달빛 + 달의 힘 비례 충전 —
        // 대상 1명당 +1(천사/중립), 악마면 +3(canon 달빛 +10%/악마 +30%, 100% = moonGauge 10).
        { id: "luna_moonlight", name: "고요한 적막", targetType: "NONE", priority: 5, effects: [
          { type: "Charge", target: "VoteTarget", tag: "moonGauge", amount: 1, demonAmount: 3 },
          { type: "Charge", target: "SuspectTarget", tag: "moonGauge", amount: 1, demonAmount: 3 },
          { type: "AddTag", target: "VoteTarget", tag: "moonlit" },
          { type: "AddTag", target: "SuspectTarget", tag: "moonlit" },
        ] },
        // 공포 속에 밀어 넣다(v2, 1회): 달의 힘 100%(moonGauge 10) 이상일 때만 발동(소비) — 천사→악마팀 타락.
        // canon "1회 제한" — maxUses:1. 100% 충전을 dawn/moonrise 와 분기로 소비(셋 중 하나).
        { id: "luna_corrupt", name: "공포 속에 밀어 넣다", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, maxUses: 1, targetFilter: { excludeRoleSets: ["demonKiller", "helper"], excludeRoles: ["pasua", "converted", "corrupted"], message: "천사만 타락시킬 수 있습니다." }, requiresCounter: { key: "moonGauge", min: 10, consume: true }, effects: [{ type: "Corrupt", target: "Target" }] },
        // 해가 저문다(v2, 1회): 100% 충전 분기 ① — 다음 아침 토론을 생략하고, 그 처형 투표에서
        // *능력으로 증가한 투표가치(voteValueMod>0)를 마이너스 판정*(canon "패시브 제외 능력으로
        // 증가한 투표가치를 마이너스로 판정"). engine 이 state.modifiers.dawnRule=1 을 세팅 → tally
        // 가 그 라운드 voteValueMod 의 양수 부호를 반전(우노 명예 +10 → -10 처럼 표 경로 역전).
        { id: "luna_dawn", name: "해가 저문다", targetType: "NONE", priority: 5, maxUses: 1, requiresCounter: { key: "moonGauge", min: 10, consume: true }, effects: [] },
        // 달이 차오른다(v2, 1회): 100% 충전 분기 ② — 그 밤 한정으로 악마(actualFaction='demon')의
        // 처치(Kill)가 달빛(moonlit 태그) 보유자 누구에게든 발동하면 *모든 달빛 대상*에 같은 효과
        // (canon "악마가 달빛 부여 대상 지목 시 달빛 부여 모두에게 같은 효과"). engine 이
        // state.modifiers.moonriseRule=1 → applyEffect Kill case 가 달빛 cascade. 그 밤 종료 시 자동 해제.
        // priority 2 — Silence(1) 후 처리(봉인된 루나는 발동 차단), Kill(4) 전 처리(cascade 활성 보장).
        { id: "luna_moonrise", name: "달이 차오른다", targetType: "NONE", priority: 2, maxUses: 1, requiresCounter: { key: "moonGauge", min: 10, consume: true }, effects: [] },
      ],
    },
  },
  {
    // 로건(조력자-10): 부서진 펜던트 = 네 안에 없는 것(그 밤 대상 능력 무력화=봉인, v2). vault [[로건]].
    id: "logen",
    name: "로건",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        // 네 안에 없는 것(v2): 대상의 *다음* 능력 효과를 소멸(Nullify, 지속·발동 시 소비).
        // 봉인(그 밤만)과 달리 대상이 능력을 쓸 때까지 기다렸다 무효화한다.
        // 부서진 펜던트 3+ 적용 시 지정 대상 +2(targetCountCounter: pendantTargetBonus, 패시브가 세팅).
        { id: "logen_nullify", name: "네 안에 없는 것", targetType: "SINGLE_ALIVE", priority: 1, excludeSelf: true, targetCount: 1, targetCountCounter: "pendantTargetBonus", effects: [{ type: "Nullify", target: "Target" }] },
        // 전부 괜찮을 거야(원문 〈능력2〉 사용/1회): 자신 제외 전원(AllOthers) 대상.
        //   - 펜던트/부서진 펜던트 적용자(tag "pendant" = 악마팀 처치자) → 그 밤 무적(Protect).
        //   - 비적용자 → 파멸 1중첩(GrantCount doom +1). 파멸 2중첩 도달 시 그 자리에서 소멸
        //     (Kill annihilate — 부활 불가). GrantCount 가 먼저 doom 을 올린 뒤 Kill 이 doom≥2 게이트로 발동.
        { id: "logen_allwell", name: "전부 괜찮을 거야", targetType: "ALL", priority: 3, maxUses: 1,
          effects: [
            { type: "Protect", target: "AllOthers", onlyIfTargetTag: "pendant" },
            { type: "GrantCount", target: "AllOthers", tag: "doom", amount: 1, skipIfTargetTag: "pendant" },
            { type: "Kill", target: "AllOthers", annihilate: true, skipIfTargetTag: "pendant", onlyIfTargetCounter: { key: "doom", min: 2 } },
          ] },
      ],
    },
  },
  {
    // 엘런(조력자-13): 박해자 = 대상의 받는-투표가치 누진(v2). 표적을 처형대로 민다.
    id: "ellen",
    name: "엘런",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        // 박해자(v2): 직전에 *투표*한 대상이 다음 집계에서 받는-투표가치 +3(substrate VoteTarget).
        // 표적을 처형대로 민다 — 별도 지목 없이 자기 투표를 따라간다(canon 박해자).
        // 박해(v2 누진): 직전 투표 대상의 받는-투표가치가 *지속 누적*(persecuteBias). 같은 대상을
        // 거듭 투표·박해하면 +3, +6, +9… 처형대로 점점 민다(canon 투표마다 누진). 홀수날 한정.
        // 해체된 퍼즐 변경효과(canon "박해자 변경 — *누군가* 자아를 되찾으면 엘런 박해가 자해
        // 박해로 전환"): 비치지 않는 자아가 타깃화되면서 selfRecovered 는 *해체당한 대상*에게 붙는다.
        // 따라서 자해 전환 트리거를 전역(생존자 누군가의 selfRecovered≥1)으로 본다 — 누군가 회복하면
        // VoteTarget 박해 대신 *자신*(엘런)에게 +3 누진 자해 박해로 영구 전환(approx). 정확한 "얻은
        // 투표가치" 동적 매핑은 후속 — 현재는 고정 +3 누진 근사.
        { id: "ellen_persecute", name: "박해", targetType: "NONE", priority: 5, effects: [
          { type: "ModifyReceivedVote", target: "VoteTarget", amount: 3, tag: "persecuteBias", oddDayOnly: true, skipIfAnyPlayerCounter: { key: "selfRecovered", min: 1 } },
          { type: "ModifyReceivedVote", target: "self", amount: 3, tag: "persecuteBias", onlyIfAnyPlayerCounter: { key: "selfRecovered", min: 1 } },
        ] },
        // 비치지 않는 자아(원문 〈능력〉 타깃화): *대상(타인)*의 자아를 망가뜨린다(Shatter). 대상은
        // brokenSelf=1 로 2밤 동안 투표·의심·능력 가치를 모두 상실하고, 그 자아가 생존자 중 *행사
        // 투표가치 최고*인 carrier(대상 제외)에게 이전된다(soulCarrier_<id> 표식). 망가진 대상이
        // carrier 를 투표하면 다음 아침 회복(selfRecovered) — resolveNightActions 의 carrier-vote
        // 회복 루프가 처리. everShattered 표식으로 한 대상은 재차 해체 불가(skipIfTargetTag). 누군가
        // 자아를 되찾으면(selfRecovered) 엘런 박해가 자해 박해로 영구 전환(ellen_persecute 전역 게이트).
        { id: "ellen_shatter", name: "비치지 않는 자아", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [{ type: "Shatter", target: "Target", skipIfTargetTag: "everShattered" }] },
        // 혼탁해진 정의(원문 〈능력2〉 지정/2회): "대상 다음날 투표·의심·능력 소멸 + 자아 잃은 중이면
        // 영원히 못 찾음 + 박해자 대상이면 탈락." 매핑(보수적·원문 충실):
        //   - DelaySilence → 대상 다음 밤 봉인(능력 소멸, silencePending). 다음날 투표·의심 소멸의
        //     정밀 매핑(받는-표/의심 0 강제)은 후속 — 현재는 능력 봉인으로 근사.
        //   - Kill onlyIfTargetCounter persecuteBias≥1 → 이미 박해(persecuteBias)에 찍힌 대상이면 탈락
        //     (원문 "박해자 대상이면 탈락"의 박해-표적 해석).
        //   ('자아 잃은 중 영원히 못 찾음'은 자아-이전 시스템[비치지 않는 자아 타깃화]과 함께 후속.)
        { id: "ellen_chaos", name: "혼탁해진 정의", targetType: "SINGLE_ALIVE", priority: 5, maxUses: 2, excludeSelf: true,
          effects: [
            { type: "DelaySilence", target: "Target" },
            { type: "Kill", target: "Target", onlyIfTargetCounter: { key: "persecuteBias", min: 1 } },
          ] },
      ],
    },
  },

  // --- 천사 풀 (나머지, 랜덤 distinct). 로마즈/라이너는 위 정의 재사용. ---
  {
    // 도르단(천사-3): 탐정 조사. v1 = 조사(police_investigate 재사용). vault [[도르단]].
    id: "dordan",
    name: "도르단",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "police_investigate", name: "조사", targetType: "SINGLE_ALIVE", priority: 5, effects: [] },
        // 잠입 수사(v2): 대상에 '잠입' 표식. 그 대상이 그 밤 탈락하면(자/타살 무관) 불심검문 발동 —
        // 도르단은 그 밤 받은 부정 효과(상태이상) 모두 무시(engine death hook 이 retroactive 정화).
        // canon '대상 능력 발동 확인'(관찰 리포트)은 후속(정보 통지).
        { id: "dordan_infiltrate", name: "잠입 수사", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [{ type: "AddTag", target: "Target", tag: "infiltrated" }] },
      ],
    },
    // 침착한 탐정: 밤 탈락 1명당 단서 +1(3개부터 정밀 조사 — match-action).
    deathHook: { perDeath: { counter: "clue", amount: 1 } },
  },
  {
    // 하브레터스(천사-4): 치료자 v2 — 생명의 언약 + 삶이 있는 곳으로(양방향 상호추리). vault [[하브레터스]].
    id: "habreterus",
    name: "하브레터스",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        // 생명의 언약(하브레터스): 치료 + 소명 — 그 밤 실제 공격을 막으면 시전자 투표가치 +3.
        // 추가로 callingCooldown 1일 단축은 engine 의 saveRewards 분기에서 하브 한정으로 처리(canon "성공 시 소명 대기 -1일").
        { id: "doctor_heal", name: "치료", targetType: "SINGLE_ALIVE", priority: 3, onSaveGrantSelf: { counter: "voteValueMod", amount: 3 }, effects: [{ type: "Protect", target: "Target", duration: "1_NIGHT" }] },
        // 삶이 있는 곳으로(v2, 양방향 상호추리): 하브 측 — 의심 가는 악마를 지목, 적중(처치자)이면
        // 자기 부정효과 정화(Deduce). 악마 측 — demon_deduce 액션(대악마 전용)이 하브를 지목·적중 시
        // 하브 다음 처치(Annihilate, 치료 무시). 새 effect 없음 — Deduce 가 source.actualFaction 으로 분기.
        { id: "habreterus_deduce", name: "삶이 있는 곳으로", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [{ type: "Deduce", target: "Target" }] },
      ],
    },
    // 임종 선언(canon): 그 라운드 누군가 탈락하면 callingPending +1. engine 이 hab 한정 후처리로
    // cooldown==0 인 밤에만 소명 발동(voteValueMod -1 + countBonus +1 + cleanse + cooldown=3).
    deathHook: { perDeath: { counter: "callingPending", amount: 1 } },
  },
  {
    // 미즐렛(천사-15): 디저트 선물 = 탈락자 부활(v2). 탈락한 대상을 되살린다.
    // maxUses 1 — 부활이 무제한이면 밤 사망과 상쇄돼 게임이 수렴하지 않는다
    // (verification P0-B 교착 엔진). 엔진 resolveNightActions 가 counters.used_* 로 강제.
    id: "mizlet",
    name: "미즐렛",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "mizlet_revive", name: "디저트 선물(부활)", targetType: "SINGLE_DEAD", priority: 3, maxUses: 1, effects: [{ type: "Heal", target: "Target" }] },
        // 디저트 선물(v2, 생존자 버프): 쿠키/푸딩 — 그 밤 보호 + 디저트 태그. 다수복귀 패시브는 후속.
        { id: "mizlet_dessert", name: "디저트 선물", targetType: "SINGLE_ALIVE", priority: 3, effects: [{ type: "Protect", target: "Target", duration: "1_NIGHT" }, { type: "AddTag", target: "Target", tag: "dessert" }] },
        // 고급 와인(v2, 1회): 전원 부정효과 제거(Cleanse All). 디저트 미제공자(태그 없음)는 투표가치
        // -1(skipIfTargetTag: dessert). 디저트 받은 자는 정화만(대화는 후속). 1회 — 누적 -1 남용 방지.
        { id: "mizlet_wine", name: "고급 와인", targetType: "NONE", priority: 5, maxUses: 1, effects: [
          { type: "Cleanse", target: "All" },
          // 투표가치 -1 은 effect(영속 voteValueMod)로 주면 회복이 안 돼 전원 0 으로 깔려 처형이
          // 영구 봉인된다(버그). resolveNightActions 의 wine 루프에서 **1일 한정** counter
          // (wineVotePenalty)로 부여 → 다음 처형 투표 1회만 적용 후 phase-advance 가 소비/해제.
        ] },
      ],
    },
  },
  {
    // 헬렌(천사-17): 황금빛 수면 — 생존자에게 걸면 수면(보호+행동봉인+부정효과 무효, Sleep),
    // 탈락자에게 걸면 부활(자유로운 새, Heal·1회). v2: Sleep 이펙트 추가.
    id: "helen",
    name: "헬렌",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "helen_revive", name: "황금빛 수면(부활)", targetType: "SINGLE_DEAD", priority: 3, maxUses: 1, effects: [{ type: "Heal", target: "Target" }] },
        // 황금빛 수면(v2): 대상 수면 + 'remembered' 표식(영혼 기억). allowRememberedDead 로 탈락 후에도
        // 같은 대상 지정 가능(canon "기억된 플레이어는 탈락 후에도 수면 발동 가능"). 사망 상태로 대상이
        // 들어오면 Sleep case 가 부활(alive=true) + 일반 수면을 모두 적용 — "수면으로 깨면 복귀" 회로.
        { id: "helen_sleep", name: "황금빛 수면", targetType: "SINGLE_ALIVE", priority: 3, allowRememberedDead: true, effects: [
          { type: "Sleep", target: "Target" },
          { type: "AddTag", target: "Target", tag: "remembered" },
        ] },
        // 자유로운 새(v2, 1회): 탈락자 한 명을 추가로 복귀시킨다(Heal dead). canon '다음 아침 탈락자
        // 생존 행동 + 수면-기억 복귀'의 바운디드 코어 — 수면으로 깨면 복귀하는 지속 메커니즘은 후속.
        { id: "helen_freebird", name: "자유로운 새", targetType: "SINGLE_DEAD", priority: 3, maxUses: 1, effects: [{ type: "Heal", target: "Target" }] },
      ],
    },
  },
  {
    // 우노(천사-6): 명예(배정 시 자기 countBonus +1) + 투쟁 = 대상 소속 카운트 +1(v2).
    id: "uno",
    name: "우노",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "uno_struggle", name: "투쟁", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [
          { type: "GrantCount", target: "Target", amount: 1 },
          { type: "GrantCount", target: "Target", tag: "missionCharge", amount: 1 },
        ] },
        // 용맹함(v2 완성, 1회): ① 전원에게 투쟁(GrantCount All + missionCharge) ② 자기 부정효과 제거(Cleanse self)
        // ③ 우노가 직전에 투표한 대상(VoteTarget)을 처형(Kill, canon "사망자로 기록" = 실제 처형,
        // 사용자 확정 2026-06-17) + 소속 공개(RevealRole, public) ④ 그 대상이 천사면(동료 살해)
        // 우노 자신이 '명예 실추' = 다음 밤 행동 불가(DelaySilence selfPenalty — 게이트는 대상 진영,
        // 봉인은 시전자). canon "천사 소속이면 명예 실추" 를 동료 살해 자기 처벌로 해석(처형 확정에
        // 따른 정합 — 죽은 대상 봉인은 무의미). VoteTarget 미투표 시 ③④ 자동 생략.
        { id: "uno_valor", name: "용맹함", targetType: "SELF", priority: 5, maxUses: 1, effects: [
          { type: "Cleanse", target: "self" },
          { type: "GrantCount", target: "All", amount: 1 },
          { type: "GrantCount", target: "All", tag: "missionCharge", amount: 1 },
          { type: "RevealRole", target: "VoteTarget" },
          { type: "Kill", target: "VoteTarget" },
          { type: "DelaySilence", target: "VoteTarget", onlyFactions: ["angel"], selfPenalty: true },
        ] },
      ],
    },
  },
  {
    // 아서(천사-14): 여명의 기사. 결백/타락 판정은 *진영이 아니라 행위 이력*(counters.tainted —
    // 부정 효과를 한 번이라도 적용했는가)으로 가린다(vault 아서 §해오름). 잔불 대검은 본래
    // 캐논상 *하나의 무기* — 결백자엔 무적(Protect), 타락자엔 폭열→재적용 소멸(Annihilate 2단).
    // (구버전이 진영 onlyFactions 로 arthur_emberblade/arthur_judge 두 액션으로 쪼갠 것은 오류.)
    id: "arthur",
    name: "아서",
    faction: "angel",
    passives: [], // 여명의 기사·위용은 engine.ts 의 applyDawnbreakerPassive/prowessVoteBonus 경로에서 처리.
    actions: {
      night: [
        // 잔불이 꺼지기 전에(3명 지정): 3명 각각에 '해오름' 표식(silent, 통지 X) + 조사(Verdict
        // 결백/타락 통지) 부여 + '잔불 대검' 1충전(발동당 총 +1). 해오름은 위용(투표가치)의 토대.
        // id 는 마이그레이션 호환 위해 arthur_judge 유지.
        {
          id: "arthur_judge", name: "잔불이 꺼지기 전에", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, targetCount: 3,
          effects: [
            { type: "AddTag", target: "Target", tag: "dawnrise", duration: "1_DAY" },
            { type: "Verdict", target: "Target" },
            { type: "GrantCount", target: "self", tag: "emberCharge", amount: 1 },
          ],
        },
        // 잔불 대검: 충전(emberCharge) 1 소비. 결백(tainted 없음)=하루 무적, 타락(tainted)=폭열,
        // 폭열된 타락자 재적용 시 소멸(Annihilate 가 branded→annihilated 2단을 자체 처리).
        {
          id: "arthur_emberblade", name: "잔불 대검", targetType: "SINGLE_ALIVE", priority: 4, excludeSelf: true,
          requiresCounter: { key: "emberCharge", min: 1, consumeAmount: 1 },
          effects: [
            { type: "Protect", target: "Target", duration: "1_NIGHT", skipIfTargetCounter: { key: "tainted", min: 1 } },
            { type: "Annihilate", target: "Target", onlyIfTargetCounter: { key: "tainted", min: 1 } },
          ],
        },
      ],
    },
  },
  {
    // 세이카(천사-12): 초신성 = 그 밤 대상의 능력 발동을 봉인(v2). priority 1(먼저 처리).
    id: "seika",
    name: "세이카",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        // 초신성(v2): 대상의 받은 부여 효과 제거(Cleanse) + 그 밤 능력 봉인(Silence). 같은
        // 대상 재적용 시 영구 봉인(tag=seikaMark 표식 누적). Cleanse→Silence 순(먼저 씻고 봉인).
        // 별이 떠오른 밤(canon 패시브): 초신성 발동 다음 밤은 의심 투표가 생략된다. onFireSetCounter
        // 로 source(세이카)에 starlitNext 표식 → phase-advance 가 다음 night_suspect 진입을 night 로 전환.
        { id: "seika_supernova", name: "초신성", targetType: "SINGLE_ALIVE", priority: 1, onFireSetCounter: { key: "starlitNext", value: 1 }, effects: [{ type: "Cleanse", target: "Target" }, { type: "Silence", target: "Target", tag: "seikaMark" }] },
        // 자신만 아플 거야(v2 완성, 1회): 전원의 받은 부여 효과를 세이카가 흡수(Absorb All) —
        // 대상은 정화되고 세이카에 흡수량 누적(absorbedDebuffs). 누적 3+ 이면 세이카 소멸 + 이틀 후
        // 악마팀 공개(demonRevealIn 카운트다운 → demons_revealed). priority 5(마지막)에 흡수.
        // ※ canon '악마팀 효과 3개+'의 악마팀 출처 판별은 effect provenance 미보유라 '받은 부정
        // 효과 수'로 근사(결정 기록 — 후속에서 출처 태깅으로 정밀화).
        { id: "seika_absorb", name: "자신만 아플 거야", targetType: "NONE", priority: 5, maxUses: 1, effects: [{ type: "Absorb", target: "All" }] },
      ],
    },
  },
  {
    // 루루(천사-30): 영혼을 만지는 음색 = 매료(v2). 대상의 처형 투표를 무력화하고 루루에게 양도.
    id: "luru",
    name: "루루",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "luru_charm", name: "영혼을 만지는 음색", targetType: "SINGLE_ALIVE", priority: 5, excludeSelf: true, effects: [{ type: "Charm", target: "Target" }] },
        // 소나타(v2): 매료 3명 누적(charmCount) 시 연주 — 전원 부정효과 제거(Cleanse All) +
        // 루루 자신 하루 무적(Protect). 발동 시 게이지 소비. 악보 교체(투표 재설계)는 후속.
        { id: "luru_sonata", name: "아름다운 영혼을 위한 소나타", targetType: "NONE", priority: 5, requiresCounter: { key: "charmCount", min: 3, consume: true }, effects: [{ type: "Cleanse", target: "All" }, { type: "Protect", target: "self", duration: "1_NIGHT" }] },
        // 악보 교체(v2, 1회): 자투 악보 — 루루 자신의 투표가치 영구 +1(voteWeightBonus). canon 무투
        // (다음 아침 2회 투표)는 별도 능력(luru_mute) 로 분리. 다중 대상 투표·반론 등판은 후속.
        { id: "luru_score", name: "악보 교체(자투)", targetType: "NONE", priority: 5, maxUses: 1, effects: [{ type: "GrantCount", target: "self", tag: "voteWeightBonus", amount: 1 }] },
        // 악보 교체 — 무투(v2, 1회): 다음 아침 처형 투표를 2회 행사. canon "무투(다음 아침 투표 2회)".
        // self voteCountBonus +1 — tally 가 voteValue * (1 + voteCountBonus) 로 가산(2배 효과).
        // phase-advance 가 처형 투표 종료 후 voteCountBonus 를 0 으로 소비(1회 한정).
        { id: "luru_mute", name: "악보 교체(무투)", targetType: "NONE", priority: 5, maxUses: 1, effects: [{ type: "GrantCount", target: "self", tag: "voteCountBonus", amount: 1 }] },
      ],
    },
  },
];

// === 기본 로스터 진영 풀 / 판정 세트 (match-start·match-action·engine 공유) ===
// 악마 처치자(살해 능력 보유). 조사·포교 차단 판정은 이 집합 기준 — 가인 등 조력자는
// faction='demon' 이지만 처치자가 아니므로 조사 시 '천사'로 보인다(canon §1).
export const DEMON_KILLER_ROLES = ["demon", "phantom", "malen"];
// 조력자 풀(악마팀, 조사 시 천사). 가인만 보호막(배정 시 주입).
export const HELPER_ROLES = ["gain", "luna", "logen", "ellen"];
// 천사 풀 — match-start 가 나머지 슬롯을 여기서 distinct 추첨(대천사 미포함, off).
export const ANGEL_ROLES = [
  "romaz", "rainer", "dordan", "habreterus", "mizlet", "helen", "uno", "arthur", "seika", "luru",
];

export function isDemonKillerRole(role?: string | null): boolean {
  return !!role && DEMON_KILLER_ROLES.includes(role);
}

// === 접선(시작 회로) 정본 (2026-06-12, 원본 시트 — 조력자 패시브가 결정) ===
// 기본값: 악마와 조력자는 서로 모른 채 시작한다 (채팅·동료 공개 없음).
//   가인 "진실을 가리는 암흑" — 악마와 접선·대화, 두 번째 밤 종료 시 패시브 삭제(채팅 만료)
//   로건 "부서진 펜던트"     — 시작 시 악마 접선 (영구)
//   루나·엘런               — 접선 없음
// 악마측 오버라이드: 팬텀 "침묵의 밤" — 접선(대화) 불가, 대신 서로 정체·직업 통지만.
export const HELPER_CONTACT: Record<string, { expiresAfterNight?: number }> = {
  gain: { expiresAfterNight: 3 },
  logen: {},
};
export const CONTACT_BLOCKED_DEMONS = ["phantom"];

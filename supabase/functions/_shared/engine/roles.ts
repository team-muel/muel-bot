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
          effects: [{ type: "Kill", target: "Target" }],
        },
        { id: "daeakma_brand", name: "메피스토 낙인", targetType: "SINGLE_ALIVE", priority: 5, effects: [{ type: "Rebrand", target: "Target" }] },
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
    actions: {},
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
    id: "gain",
    name: "가인",
    faction: "demon",
    passives: [],
    actions: {},
  },
  // --- W6 v1 중립 (canon §1 중립, 특수 카테고리-4 파스아) ---
  {
    // 파스아: 사이비 교주(중립). 시그니처 = 포교(전향). 매 밤 대상 1명을 전향시켜
    // 자기 진영(converted)으로 흡수. 누적 3명 전향 시 파스아 단독 즉시 승리(checkWinCondition).
    // canon: 악마·중립 포교 불가 → 효과/검증에서 차단(천사 + 가인만 전향 가능).
    // v2: 포교(전향) + 신앙(대상 탈락, 악마 면역). 연속 포교 불가(convertCooldown).
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
          effects: [{ type: "ChangeFaction", target: "Target" }],
        },
        {
          // 신앙: 대상 탈락(악마는 탈락 안 함, canon §파스아). Kill 재사용 + immuneFactions.
          id: "pasua_faith",
          name: "신앙",
          targetType: "SINGLE_ALIVE",
          priority: 4,
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
        { id: "phantom_nightmare", name: "악몽", targetType: "SINGLE_ALIVE", priority: 4, effects: [{ type: "Nightmare", target: "Target" }] },
        { id: "phantom_seal", name: "어둠이 내린 도시", targetType: "SINGLE_ALIVE", priority: 1, effects: [{ type: "Silence", target: "Target" }] },
        { id: "phantom_eclipse", name: "일식", targetType: "SELF", priority: 5, maxUses: 1, effects: [{ type: "Eclipse", target: "self" }] },
      ],
    },
  },
  {
    // 말렌(악마-7): 혼령 방출(처치) + 빙의(그 밤 행동 봉인 + 악마팀 카운트 전환, priority 1).
    // 말렌의 처치 능력은 canon '혼령 방출'. 혼/시체 누적 다단계는 후속.
    id: "malen",
    name: "말렌",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        { id: "malen_release", name: "혼령 방출", targetType: "SINGLE_ALIVE", priority: 4, effects: [{ type: "Kill", target: "Target" }] },
        { id: "malen_possess", name: "빙의", targetType: "SINGLE_ALIVE", priority: 1, effects: [{ type: "Possess", target: "Target" }] },
      ],
    },
  },
  {
    // 베스토(악마-14): 히든 포지션(처치) + 변신(솔/하베스토 토글 — 조사 회피). 배후 다단계는 후속.
    id: "besto",
    name: "베스토",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        { id: "besto_hidden", name: "히든 포지션", targetType: "SINGLE_ALIVE", priority: 4, effects: [{ type: "Kill", target: "Target" }] },
        { id: "besto_shift", name: "변신", targetType: "SELF", priority: 1, effects: [{ type: "Disguise", target: "self" }] },
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
        { id: "luna_corrupt", name: "공포 속에 밀어 넣다", targetType: "SINGLE_ALIVE", priority: 5, effects: [{ type: "Corrupt", target: "Target" }] },
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
        { id: "logen_nullify", name: "네 안에 없는 것", targetType: "SINGLE_ALIVE", priority: 1, effects: [{ type: "Silence", target: "Target" }] },
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
        { id: "ellen_persecute", name: "박해", targetType: "SINGLE_ALIVE", priority: 5, effects: [{ type: "ModifyReceivedVote", target: "Target", amount: 3 }] },
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
      ],
    },
  },
  {
    // 하브레터스(천사-4): 생명의 언약 = 치료. v1 = 치료(doctor_heal 재사용). vault [[하브레터스]].
    id: "habreterus",
    name: "하브레터스",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "doctor_heal", name: "치료", targetType: "SINGLE_ALIVE", priority: 3, effects: [{ type: "Protect", target: "Target", duration: "1_NIGHT" }] },
      ],
    },
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
        { id: "mizlet_revive", name: "디저트 선물", targetType: "SINGLE_DEAD", priority: 3, maxUses: 1, effects: [{ type: "Heal", target: "Target" }] },
      ],
    },
  },
  {
    // 헬렌(천사-17): 황금빛 수면 = 자유로운 새 부활(v2). 탈락한 대상을 되살린다.
    // maxUses 1 — 미즐렛과 동일 근거 (P0-B).
    id: "helen",
    name: "헬렌",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "helen_revive", name: "황금빛 수면", targetType: "SINGLE_DEAD", priority: 3, maxUses: 1, effects: [{ type: "Heal", target: "Target" }] },
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
        { id: "uno_struggle", name: "투쟁", targetType: "SINGLE_ALIVE", priority: 5, effects: [{ type: "GrantCount", target: "Target", amount: 1 }] },
      ],
    },
  },
  {
    // 아서(천사-14): 여명의 기사(배정 시 자기 보호막 1) + 잔불 대검 = 대상에게 하루 무적(v2).
    id: "arthur",
    name: "아서",
    faction: "angel",
    passives: [],
    actions: {
      night: [
        { id: "arthur_emberblade", name: "잔불 대검", targetType: "SINGLE_ALIVE", priority: 3, effects: [{ type: "Protect", target: "Target", duration: "1_NIGHT" }] },
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
        { id: "seika_supernova", name: "초신성", targetType: "SINGLE_ALIVE", priority: 1, effects: [{ type: "Cleanse", target: "Target" }, { type: "Silence", target: "Target", tag: "seikaMark" }] },
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
        { id: "luru_charm", name: "영혼을 만지는 음색", targetType: "SINGLE_ALIVE", priority: 5, effects: [{ type: "Charm", target: "Target" }] },
      ],
    },
  },
];

// === 기본 로스터 진영 풀 / 판정 세트 (match-start·match-action·engine 공유) ===
// 악마 처치자(살해 능력 보유). 조사·포교 차단 판정은 이 집합 기준 — 가인 등 조력자는
// faction='demon' 이지만 처치자가 아니므로 조사 시 '천사'로 보인다(canon §1).
export const DEMON_KILLER_ROLES = ["demon", "phantom", "malen", "besto"];
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
  gain: { expiresAfterNight: 2 },
  logen: {},
};
export const CONTACT_BLOCKED_DEMONS = ["phantom"];

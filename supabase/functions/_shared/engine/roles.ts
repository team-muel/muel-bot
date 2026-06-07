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
    id: "demon",
    name: "Demon",
    faction: "demon",
    passives: [],
    actions: {
      night: [
        {
          id: "demon_kill",
          name: "Kill",
          targetType: "SINGLE_ALIVE",
          priority: 4,
          effects: [{ type: "Kill", target: "Target" }],
        },
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
];

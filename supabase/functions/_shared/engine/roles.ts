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
];

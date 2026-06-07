import { jsonResponse } from "../_shared/cors.ts";
import { MatchState } from "../_shared/engine/types.ts";
import { resolveNightActions } from "../_shared/engine/engine.ts";

Deno.serve(async (req: Request) => {
  const initialState: MatchState = {
    matchId: "test-match-001",
    dayCount: 1,
    phase: "night",
    angelCount: 3,
    demonCount: 2,
    modifiers: {},
    players: {
      "user_citizen": {
        userId: "user_citizen", originalRole: "citizen", currentRole: "citizen", actualFaction: "angel", treatedAsFaction: "angel",
        baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
      },
      "user_doctor": {
        userId: "user_doctor", originalRole: "doctor", currentRole: "doctor", actualFaction: "angel", treatedAsFaction: "angel",
        baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
      },
      "user_demon": {
        userId: "user_demon", originalRole: "demon", currentRole: "demon", actualFaction: "demon", treatedAsFaction: "demon",
        baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: { shield: 1 }
      },
      "user_helper": {
        userId: "user_helper", originalRole: "helper", currentRole: "gain", actualFaction: "demon", treatedAsFaction: "demon",
        baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
      },
      "user_police": {
        userId: "user_police", originalRole: "police", currentRole: "romaz", actualFaction: "angel", treatedAsFaction: "angel",
        baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
      }
    },
    actionStack: [
      { sourceUserId: "user_demon", targetUserId: "user_citizen", actionType: "demon_kill", priority: 4 }, // 악마 -> 시민
      { sourceUserId: "user_doctor", targetUserId: "user_citizen", actionType: "doctor_heal", priority: 3 }, // 의사 -> 시민 (방어)
      { sourceUserId: "user_police", targetUserId: "user_demon", actionType: "romaz_suspect", priority: 5 } // 로마즈 -> 악마 지목
    ]
  };

  const { newState, events } = resolveNightActions(initialState);

  const report = {
    scenario: "악마가 시민 킬 -> 의사가 시민 힐 -> 로마즈가 악마를 용의자로 지목",
    generatedEvents: events.map((e: any) => `${e.type}: ${JSON.stringify(e.payload || e.userId)}`),
    playerStatuses: Object.keys(newState.players).map(id => {
      const p = newState.players[id];
      return `${id} (${p.currentRole}): ${p.alive ? "생존" : "사망"} | 태그: [${p.tags.join(', ')}]`;
    })
  };

  return jsonResponse(report, { origin: req.headers.get("Origin") });
});

import { MatchState } from "./types.ts";
import { resolveNightActions } from "./engine.ts";

console.log("=== 곰돌이 마피아 엔진 시뮬레이션 시작 ===");

// 1. 초기 매치 상태 구성 (가상의 5명 플레이어)
const initialState: MatchState = {
  matchId: "test-match-001",
  dayCount: 1,
  phase: "night",
  angelCount: 3,
  demonCount: 2,
  modifiers: {},
  players: {
    "user1": {
      userId: "user1", originalRole: "citizen", currentRole: "citizen", actualFaction: "angel", treatedAsFaction: "angel",
      baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
    },
    "user2": {
      userId: "user2", originalRole: "doctor", currentRole: "doctor", actualFaction: "angel", treatedAsFaction: "angel",
      baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
    },
    "user3": {
      userId: "user3", originalRole: "demon", currentRole: "demon", actualFaction: "demon", treatedAsFaction: "demon",
      baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: { shield: 1 }
    },
    "user4": {
      userId: "user4", originalRole: "helper", currentRole: "gain", actualFaction: "demon", treatedAsFaction: "demon",
      baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
    },
    "user5": {
      userId: "user5", originalRole: "police", currentRole: "romaz", actualFaction: "angel", treatedAsFaction: "angel",
      baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0, alive: true, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {}
    }
  },
  actionStack: [
    { sourceUserId: "user3", targetUserId: "user1", actionType: "demon_kill", priority: 4 }, // 대악마가 시민(1) 공격
    { sourceUserId: "user2", targetUserId: "user1", actionType: "doctor_heal", priority: 3 }, // 의사가 시민(1) 보호
    { sourceUserId: "user5", targetUserId: "user3", actionType: "romaz_suspect", priority: 5 } // 로마즈가 악마를 용의자로 지목
  ]
};

console.log("시나리오: 악마가 시민 공격 -> 의사가 시민 보호 -> 로마즈가 악마를 용의자로 지목");

// 2. 엔진 가동
const { newState, events } = resolveNightActions(initialState);

// 3. 결과 출력
console.log("\n[발생한 이벤트]");
events.forEach(e => console.log(`- ${e.type}:`, e.payload || e.userId));

console.log("\n[플레이어 생존 상태]");
for (const [id, p] of Object.entries(newState.players)) {
  console.log(`${id}(${p.currentRole}): ${p.alive ? "생존" : "사망"} | 태그: ${p.tags.join(', ')}`);
}

console.log("\n=== 시뮬레이션 종료 ===");

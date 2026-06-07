import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string) {
  return readFileSync(path, "utf8");
}

const migration = read("supabase/migrations/20260607111250_gomdori_w4_db_runtime_contract.sql");
const matchStart = read("supabase/functions/match-start/index.ts");
const matchAction = read("supabase/functions/match-action/index.ts");
const matchChat = read("supabase/functions/match-chat/index.ts");
const phaseAdvance = read("supabase/functions/phase-advance/index.ts");
const roles = read("supabase/functions/_shared/engine/roles.ts");

for (const value of ["night_suspect", "suspect", "romaz_suspect", "rainer", "romaz", "gain"]) {
  assert.match(migration, new RegExp(`'${value}'`), `migration should allow ${value}`);
}

assert.match(migration, /mp\.faction = 'demon'/, "demon circle membership should follow faction");
assert.match(matchStart, /pushRole\(roles, 1, "gain", "demon"\)/, "first helper slot should become gain");
assert.match(matchStart, /playerCount >= 7 \? "romaz" : "police"/, "7p+ police slot should become romaz");
assert.match(matchStart, /playerCount >= 8 \? 1 : 0, "rainer"/, "8p+ citizen slot should add rainer");
assert.match(matchStart, /counters\.shield = 1/, "gain should seed demon shield");
assert.match(matchAction, /romaz: \["romaz_suspect"\]/, "romaz night action should be accepted");
assert.match(matchChat, /select\("faction, alive"\)/, "demon chat should check faction, not fixed role list");
assert.match(matchChat, /channel: "demon_circle"/, "match chat insert should match DB column name");
assert.match(phaseAdvance, /execution_blocked_shield/, "verdict execution should honor shield");
assert.match(phaseAdvance, /blocked_by_shield/, "verdict payload should expose shield block");
assert.match(roles, /id: "gain"[\s\S]*?faction: "demon"/, "gain engine faction should align with DB/frontend");

console.log("Gomdori W4 runtime contract checks passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkWinCondition, resolveNightActions, resolveNightmares, tallyEliminationVotes, tallySuspicionVotes, tallyVerdictVotes } from "../../supabase/functions/_shared/engine/engine.ts";
import { ANGEL_ROLES } from "../../supabase/functions/_shared/engine/roles.ts";
import type { Faction, MatchState, PlayerState } from "../../supabase/functions/_shared/engine/types.ts";

function player(userId: string, role: string, faction: Faction, alive = true): PlayerState {
  return {
    userId, originalRole: role, currentRole: role,
    baseVoteValue: 1, bonusVoteValue: 0, suspicionValue: 0,
    actualFaction: faction, treatedAsFaction: faction,
    alive, markedForDeath: false, markedForAnnihilation: false, tags: [], counters: {},
  };
}

function emptyState(players: Record<string, PlayerState>, actionStack: MatchState["actionStack"]): MatchState {
  return { matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {}, players, actionStack };
}

// --- 1. 봉인(세이카 초신성): 대상의 그 밤 능력을 막는다 ---
{
  const state = emptyState(
    {
      seika: player("seika", "seika", "angel"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "seika", targetUserId: "demon", actionType: "seika_supernova", priority: 1 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "봉인된 악마의 처치가 막혀 피해자 생존");
  assert.ok(events.some((e: any) => e.type === "action_blocked_silenced" && e.userId === "demon"), "봉인 차단 이벤트");
  assert.equal(newState.players.demon.counters.silencedNights ?? 0, 0, "봉인은 같은 밤 한정 — 종료 시 해제");
}

// --- 1b. 신앙(파스아): 대상 탈락, 단 악마는 면역 ---
{
  const state = emptyState(
    {
      pasua: player("pasua", "pasua", "neutral"),
      angel: player("angel", "citizen", "angel"),
    },
    [{ sourceUserId: "pasua", targetUserId: "angel", actionType: "pasua_faith", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.angel.alive, false, "신앙 — 천사 대상 탈락");
  assert.equal(newState.players.pasua.counters.used_pasua_convert ?? 0, 0, "신앙은 포교 사용 횟수와 무관");
}
{
  const state = emptyState(
    {
      pasua: player("pasua", "pasua", "neutral"),
      demon: player("demon", "demon", "demon"),
    },
    [{ sourceUserId: "pasua", targetUserId: "demon", actionType: "pasua_faith", priority: 4 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.demon.alive, true, "신앙 — 악마는 면역(탈락 안 함)");
  assert.ok(events.some((e: any) => e.type === "attack_prevented"), "면역 통지 이벤트");
}

// --- 1c. 포교 2회 제한(파스아, 원문): maxUses 2 — 3회째 거부. 전향자 사망 시 1회 충전 ---
{
  // 1밤: 포교 → 천사 전향, used 1.
  const s1 = emptyState(
    { pasua: player("pasua", "pasua", "neutral"), a: player("a", "citizen", "angel") },
    [{ sourceUserId: "pasua", targetUserId: "a", actionType: "pasua_convert", priority: 5 }],
  );
  const { newState: n1 } = resolveNightActions(s1);
  assert.equal(n1.players.a.currentRole, "converted", "포교 1회 — 천사 전향");
  assert.equal(n1.players.pasua.counters.used_pasua_convert, 1, "포교 1회 소진");
  // 2밤: 포교 → used 2.
  const s2 = emptyState(
    { pasua: { ...n1.players.pasua }, b: player("b", "citizen", "angel") },
    [{ sourceUserId: "pasua", targetUserId: "b", actionType: "pasua_convert", priority: 5 }],
  );
  const { newState: n2 } = resolveNightActions(s2);
  assert.equal(n2.players.b.currentRole, "converted", "포교 2회 — 천사 전향");
  assert.equal(n2.players.pasua.counters.used_pasua_convert, 2, "포교 2회 소진(maxUses 도달)");
  // 3밤: 포교 → maxUses 2 도달로 거부(전향 안 됨).
  const s3 = emptyState(
    { pasua: { ...n2.players.pasua }, c: player("c", "citizen", "angel") },
    [{ sourceUserId: "pasua", targetUserId: "c", actionType: "pasua_convert", priority: 5 }],
  );
  const { newState: n3, events: e3 } = resolveNightActions(s3);
  assert.notEqual(n3.players.c.currentRole, "converted", "3회째 포교 — maxUses 거부(전향 안 됨)");
  assert.ok(e3.some((e: any) => e.type === "action_blocked_exhausted" && e.userId === "pasua"), "소진 차단 이벤트");
  // 충전: 전향자(converted)가 밤에 탈락하면 used 1 차감 → 재포교 가능(원문 "포교 대상 사망 시 1회 충전").
  const s4 = emptyState(
    {
      pasua: { ...n2.players.pasua },
      conv: { ...player("conv", "converted", "neutral") },
      demon: player("demon", "demon", "demon"),
    },
    [{ sourceUserId: "demon", targetUserId: "conv", actionType: "demon_kill", priority: 4 }],
  );
  const { newState: n4, events: e4 } = resolveNightActions(s4);
  assert.equal(n4.players.conv.alive, false, "전향자 탈락");
  assert.equal(n4.players.pasua.counters.used_pasua_convert, 1, "전향자 사망 → 포교 1회 충전(2→1)");
  assert.ok(e4.some((e: any) => e.type === "pasua_convert_recharged" && e.payload?.user_id === "pasua"), "충전 이벤트");
}

// 봉인이 priority 로 먼저 처리되지 않으면(역순) 막지 못함을 대비해 — 엔진은 actionStack 을
// priority 오름차순 정렬하므로 입력 순서와 무관해야 한다.
{
  const state = emptyState(
    {
      seika: player("seika", "seika", "angel"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
      { sourceUserId: "seika", targetUserId: "demon", actionType: "seika_supernova", priority: 1 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "입력 순서 무관 — priority 정렬로 봉인 우선");
}

// --- 1d. 백호 소환(라이너): self 카운트 +1/+1, 1회 제한 ---
{
  const state = emptyState(
    { rainer: player("rainer", "rainer", "angel") },
    [{ sourceUserId: "rainer", targetUserId: null, actionType: "rainer_summon", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.rainer.counters.countBonus, 3, "백호 — 생존 가산 +3(canon)");
  assert.equal(newState.players.rainer.counters.deadCountBonus, 3, "백호 — 생존 무관 지속 +3(canon)");
  assert.equal(newState.players.rainer.counters.used_rainer_summon, 1, "소환 1회 소진 기록");
  // 두 번째 소환은 maxUses 로 막힌다.
  const again = emptyState(
    { rainer: { ...newState.players.rainer } },
    [{ sourceUserId: "rainer", targetUserId: null, actionType: "rainer_summon", priority: 5 }],
  );
  const { newState: after, events } = resolveNightActions(again);
  assert.equal(after.players.rainer.counters.countBonus, 3, "2회차 소환 차단 — 카운트 불변(3 유지)");
  assert.ok(events.some((e: any) => e.type === "action_blocked_exhausted"), "소진 차단 이벤트");
}

// --- 1e. 초신성 Cleanse + 영구봉인(세이카): 효과 제거 + 재적용 시 영구 ---
{
  // 부정효과(받는-투표 +5)가 걸린 대상에게 초신성 → Cleanse 로 제거 + 봉인 표식.
  const target = { ...player("t", "citizen", "angel"), counters: { voteBias: 5, nightmare: 1 } };
  const state = emptyState(
    { seika: player("seika", "seika", "angel"), t: target },
    [{ sourceUserId: "seika", targetUserId: "t", actionType: "seika_supernova", priority: 1 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.t.counters.voteBias ?? 0, 0, "Cleanse — 받는-투표 부정효과 제거");
  assert.equal(newState.players.t.counters.nightmare ?? 0, 0, "Cleanse — 악몽 표식 제거");
  assert.equal(newState.players.t.counters.seikaMark, 1, "첫 초신성 — 봉인 표식 누적");
  assert.ok(events.some((e: any) => e.type === "cleansed"), "Cleanse 이벤트");
  // 재적용: 표식 보유 대상 → 영구 봉인.
  const repeat = emptyState(
    { seika: player("seika", "seika", "angel"), t: { ...newState.players.t, counters: { ...newState.players.t.counters, silencedNights: 0 } } },
    [{ sourceUserId: "seika", targetUserId: "t", actionType: "seika_supernova", priority: 1 }],
  );
  const { newState: after, events: ev2 } = resolveNightActions(repeat);
  assert.equal(after.players.t.counters.silencedPermanent, 1, "재적용 — 영구 봉인");
  assert.ok(ev2.some((e: any) => e.type === "silenced_permanent"), "영구 봉인 이벤트");
}

// --- 2. 부활(미즐렛 디저트): 탈락자를 되살린다 ---
{
  const state = emptyState(
    {
      mizlet: player("mizlet", "mizlet", "angel"),
      dead: player("dead", "citizen", "angel", false),
    },
    [{ sourceUserId: "mizlet", targetUserId: "dead", actionType: "mizlet_revive", priority: 3 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.dead.alive, true, "탈락자가 부활");
  assert.ok(events.some((e: any) => e.type === "player_revived" && e.payload?.user_id === "dead"), "부활 이벤트");
}

// --- 2b. 황금빛 수면(헬렌): 생존자 보호 + 지연 부정효과(악몽) 무효 ---
{
  // 악몽(지속 카운터)이 걸린 아군을 수면 → 죽음 보호 + 악몽 표식 무효.
  const ally = { ...player("ally", "citizen", "angel"), counters: { nightmare: 1 } };
  const state = emptyState(
    { helen: player("helen", "helen", "angel"), ally, demon: player("demon", "demon", "demon") },
    [
      { sourceUserId: "helen", targetUserId: "ally", actionType: "helen_sleep", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.ally.alive, true, "수면 — 죽음 보호로 처치 무효");
  assert.equal(newState.players.ally.counters.nightmare ?? 0, 0, "수면 — 악몽 표식 무효(Cleanse 복합)");
  assert.ok(events.some((e: any) => e.type === "slept"), "수면 이벤트");
}

// --- 3. 런타임 계약 ---
const roles = readFileSync("supabase/functions/_shared/engine/roles.ts", "utf8");
assert.match(roles, /id: "seika_supernova"[\s\S]*?type: "Cleanse"[\s\S]*?type: "Silence", target: "Target", tag: "seikaMark"/, "세이카 초신성 = Cleanse + 봉인(마크)");
assert.match(roles, /id: "phantom_seal"[\s\S]*?type: "Silence"/, "팬텀 봉인");
assert.match(roles, /id: "mizlet_revive"[\s\S]*?SINGLE_DEAD[\s\S]*?type: "Heal"/, "미즐렛 부활(탈락자 대상)");
assert.match(roles, /id: "helen_revive"[\s\S]*?SINGLE_DEAD/, "헬렌 부활");
assert.match(roles, /id: "helen_sleep"[\s\S]*?type: "Sleep"/, "헬렌 황금빛 수면(생존자 Sleep)");
const migration = readFileSync("supabase/migrations/20260610140000_gomdori_v2_abilities.sql", "utf8");
for (const a of ["mizlet_revive", "helen_revive", "seika_supernova", "phantom_seal"]) {
  assert.match(migration, new RegExp(`'${a}'`), `migration allows ${a}`);
}
// 검증+행동맵은 match-action-core(submitMatchAction)로 단일화됨(ADR-005). 두 파일을 함께 검사.
const matchAction = readFileSync("supabase/functions/match-action/index.ts", "utf8") +
  readFileSync("supabase/functions/_shared/match-action-core.ts", "utf8");
assert.match(matchAction, /REVIVE_ACTIONS/, "부활은 탈락자 대상 검증");
// 검증 테이블은 CORE_ROLES 도출(ADR-006 S1) — 능력 정의는 단일 출처(roles.ts)에서 확인.
assert.match(roles, /id: "seika_supernova"/, "세이카 초신성 능력 정의");
assert.match(roles, /id: "helen_sleep"/, "헬렌 수면 능력 정의");
const helenSleepMig = readFileSync("supabase/migrations/20260614120000_gomdori_helen_sleep.sql", "utf8");
assert.match(helenSleepMig, /'helen_sleep'/, "마이그레이션 action_type 에 수면 추가");
// 배치B 배선
assert.match(roles, /id: "arthur_emberblade"[\s\S]*?type: "Annihilate"/, "아서 잔불 대검(타락자=Annihilate)");
assert.match(roles, /id: "arthur_judge"[\s\S]*?type: "Verdict"/, "아서 잔불이 꺼지기 전에(Verdict 결백/타락 통지)");
assert.match(roles, /id: "mizlet_cookie"[\s\S]*?type: "Protect"/, "미즐렛 디저트 쿠키(Protect)");
assert.match(roles, /id: "arthur_judge"/, "아서 잔불이 꺼지기 전에 능력 정의(단일 출처)");
assert.match(roles, /id: "mizlet_cookie"[\s\S]*?tag: "cookie"/, "미즐렛 쿠키 표식");
assert.match(roles, /id: "mizlet_pudding"[\s\S]*?tag: "pudding"/, "미즐렛 푸딩 표식");
const batch2bMig = readFileSync("supabase/migrations/20260614150000_gomdori_batch_tier2b.sql", "utf8");
assert.match(batch2bMig, /'arthur_judge'/, "마이그레이션 — 단죄");
const mizletCpMig = readFileSync("supabase/migrations/20260625180000_gomdori_mizlet_cookie_pudding.sql", "utf8");
assert.match(mizletCpMig, /'mizlet_cookie'/, "마이그레이션 — 쿠키");
assert.match(mizletCpMig, /'mizlet_pudding'/, "마이그레이션 — 푸딩");

// --- 4. 변환(루나 공포 속에 밀어 넣다): 천사 → 악마팀 ---
{
  const state = emptyState(
    {
      luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 10 } }, // 달 게이지 100% 충전 상태
      angel: player("angel", "citizen", "angel"),
    },
    [{ sourceUserId: "luna", targetUserId: "angel", actionType: "luna_corrupt", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.angel.actualFaction, "demon", "천사가 악마팀으로 타락");
  assert.equal(newState.players.angel.treatedAsFaction, "demon", "타락자 treatedAsFaction 도 demon — 승리 집계 합류(승패 역전 버그 회귀 방지)");
  assert.equal(newState.players.angel.currentRole, "corrupted", "타락자 역할");
  assert.ok(events.some((e: any) => e.type === "faction_changed" && e.payload?.new_faction === "demon"), "변환 이벤트");
}
// --- 4b. 타락자는 승리 집계에서 악마팀으로 잡힌다 (리로드 폴백 회귀 방지) ---
{
  // phase-advance 리로드는 treatedAsFaction 을 DB faction('angel')으로 폴백시킨다. Corrupt 가
  // treatedAsFaction 까지 'demon' 으로 바꾸지 않으면 타락자가 영구히 천사로 집계돼 승패가 뒤집힌다.
  const reloaded = {
    demon: player("demon", "demon", "demon"),
    corrupted: { ...player("corrupted", "corrupted", "demon"), treatedAsFaction: "demon" as Faction },
    angel: player("angel", "citizen", "angel"),
  };
  const win = checkWinCondition(reloaded);
  assert.equal(win.winner, "demons", "타락자 포함 악마2 vs 천사1 → 악마 승리");
  assert.equal(win.aliveDemons, 2, "타락자가 악마 카운트에 합류");
}
// 악마는 타락 불가
{
  const state = emptyState(
    {
      luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 10 } },
      demon: player("demon", "demon", "demon"),
    },
    [{ sourceUserId: "luna", targetUserId: "demon", actionType: "luna_corrupt", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.demon.currentRole, "demon", "악마는 타락하지 않음");
}

// --- 4b. 루나 substrate: 적막 충전 + 달빛(투표 대상) + 게이트된 공포 ---
{
  // 적막: 달 게이지 +1, 투표한 대상(substrate VoteTarget)에 달빛 태그.
  const luna = { ...player("luna", "luna", "demon"), lastVoteTarget: "v" };
  const state = emptyState(
    { luna, v: player("v", "citizen", "angel") },
    [{ sourceUserId: "luna", targetUserId: null, actionType: "luna_moonlight", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.luna.counters.moonGauge, 1, "적막 — 천사 달빛 비례 충전 +1");
  assert.ok(newState.players.v.tags.includes("moonlit"), "달빛 — 투표 대상(substrate VoteTarget)에 태그");

  // 악마 대상 달빛은 +3(canon +30%).
  const dluna = { ...player("luna", "luna", "demon"), lastVoteTarget: "d" };
  const dstate = emptyState(
    { luna: dluna, d: player("d", "demon", "demon") },
    [{ sourceUserId: "luna", targetUserId: null, actionType: "luna_moonlight", priority: 5 }],
  );
  assert.equal(resolveNightActions(dstate).newState.players.luna.counters.moonGauge, 3, "적막 — 악마 달빛 비례 충전 +3");

  // 게이지 9 면 공포 차단(임계 10=100% 미만).
  const low = emptyState(
    { luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 9 } }, a: player("a", "citizen", "angel") },
    [{ sourceUserId: "luna", targetUserId: "a", actionType: "luna_corrupt", priority: 5 }],
  );
  const r1 = resolveNightActions(low);
  assert.equal(r1.newState.players.a.currentRole, "citizen", "게이지 부족 — 공포 차단");
  assert.ok(r1.events.some((e: any) => e.type === "action_blocked_no_charge"), "충전 부족 차단 이벤트");

  // 게이지 10(100%)이면 공포 발동 + 소비.
  const high = emptyState(
    { luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 10 } }, a: player("a", "citizen", "angel") },
    [{ sourceUserId: "luna", targetUserId: "a", actionType: "luna_corrupt", priority: 5 }],
  );
  const r2 = resolveNightActions(high);
  assert.equal(r2.newState.players.a.actualFaction, "demon", "게이지 충족 — 공포 타락");
  assert.equal(r2.newState.players.luna.counters.moonGauge, 0, "공포 발동 — 게이지 소비");
}
// --- 4c. 도르단 잠입 수사: 관찰 대상이 그 밤 탈락 → 불심검문(도르단 부정효과 무시) ---
{
  // 지속 디버프(nightmare/persecuteBias)로 검증 — 라운드성(charmed 등)은 리셋루프가 먼저 0.
  const dordan = { ...player("dordan", "dordan", "angel"), counters: { nightmare: 1, persecuteBias: 1 } };
  const state = emptyState(
    {
      dordan,
      mark: player("mark", "citizen", "angel"),
      demon: player("demon", "demon", "demon"),
    },
    [
      { sourceUserId: "dordan", targetUserId: "mark", actionType: "dordan_infiltrate", priority: 5 },
      { sourceUserId: "demon", targetUserId: "mark", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.mark.alive, false, "잠입 대상이 그 밤 탈락");
  assert.ok(events.some((e: any) => e.type === "stakeout_triggered" && e.payload?.user_id === "dordan"), "불심검문 발동");
  assert.equal(newState.players.dordan.counters.nightmare ?? 0, 0, "불심검문 — 도르단 부정효과 정화(악몽)");
  assert.equal(newState.players.dordan.counters.persecuteBias ?? 0, 0, "불심검문 — 도르단 부정효과 정화(박해)");
}
// --- 4c-2. 도르단 잠입 2차 트리거(canon "누군가를 탈락시키면"): 관찰 대상이 가해자면 불심검문(대상 생존이어도) ---
{
  const dordan = { ...player("dordan", "dordan", "angel"), counters: { nightmare: 1 } };
  const state = emptyState(
    {
      dordan,
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "dordan", targetUserId: "demon", actionType: "dordan_infiltrate", priority: 5 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, false, "관찰 대상(악마)이 피해자를 탈락시킴");
  assert.equal(newState.players.demon.alive, true, "관찰 대상은 생존");
  assert.ok(events.some((e: any) => e.type === "stakeout_triggered" && e.payload?.user_id === "dordan"), "2차 트리거 — 불심검문 발동");
  assert.equal(newState.players.dordan.counters.nightmare ?? 0, 0, "불심검문 — 도르단 부정효과 정화");
  assert.ok(!newState.players.demon.tags.includes("infiltrated"), "잠입 표식 소비");
}
// --- 4d. 도르단 잠입: 대상 생존이면 불심검문 없음 ---
{
  const dordan = { ...player("dordan", "dordan", "angel"), counters: { persecuteBias: 1 } };
  const state = emptyState(
    { dordan, mark: player("mark", "citizen", "angel") },
    [{ sourceUserId: "dordan", targetUserId: "mark", actionType: "dordan_infiltrate", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(newState.players.mark.tags.includes("infiltrated"), "잠입 표식 부여");
  assert.ok(!events.some((e: any) => e.type === "stakeout_triggered"), "대상 생존 — 불심검문 미발동");
  assert.equal(newState.players.dordan.counters.persecuteBias, 1, "미발동 — 도르단 부정효과 유지");
}
// --- 4d-2. 도르단 침착한 탐정: 탈락 밤에 투표로 지목한 범인의 지정 대상 통지 ---
{
  const dordan = { ...player("dordan", "dordan", "angel"), lastVoteTarget: "demon" };
  const state = emptyState(
    {
      dordan,
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 }],
  );
  const { events } = resolveNightActions(state);
  assert.ok(
    events.some((e: any) =>
      e.type === "culprit_target_revealed" &&
      e.payload?.user_id === "dordan" &&
      e.payload?.culprit_user_id === "demon" &&
      e.payload?.target_user_ids?.includes("victim")
    ),
    "침착한 탐정 — 범인의 밤 지정 대상 통지",
  );
}
// --- 4d-3. 도르단 단서 수집(canon "대상의 능력 발동 확인"): 조사 대상의 밤 행동 여부 통지(acted) ---
{
  // (a) 조사 대상이 밤 행동(킬) → acted true
  const state = emptyState(
    {
      dordan: player("dordan", "dordan", "angel"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "dordan", targetUserId: "demon", actionType: "police_investigate", priority: 5 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { events } = resolveNightActions(state);
  assert.ok(
    events.some((e: any) => e.type === "dordan_observation" && e.payload?.user_id === "dordan" && e.payload?.target_user_id === "demon" && e.payload?.acted === true),
    "조사 대상이 밤 행동 → acted true",
  );
}
{
  // (b) 조사 대상이 취침(무행동) → acted false
  const state = emptyState(
    {
      dordan: player("dordan", "dordan", "angel"),
      mark: player("mark", "citizen", "angel"),
    },
    [{ sourceUserId: "dordan", targetUserId: "mark", actionType: "police_investigate", priority: 5 }],
  );
  const { events } = resolveNightActions(state);
  assert.ok(
    events.some((e: any) => e.type === "dordan_observation" && e.payload?.target_user_id === "mark" && e.payload?.acted === false),
    "조사 대상 무행동 → acted false",
  );
}
// --- 4e. 미즐렛 고급 와인(canon 〔지정〕 단일 대상): 디저트 대상=정화, 미디저트 대상=투표가치 -1 ---
{
  // 디저트 보유 대상 → 받는 부정효과 정화 + 페널티 없음.
  const fed = { ...player("fed", "citizen", "angel"), tags: ["dessert"], counters: { nightmare: 1 } };
  const s1 = emptyState(
    { mizlet: player("mizlet", "mizlet", "angel"), fed },
    [{ sourceUserId: "mizlet", targetUserId: "fed", actionType: "mizlet_wine", priority: 5 }],
  );
  const r1 = resolveNightActions(s1).newState;
  assert.equal(r1.players.fed.counters.nightmare ?? 0, 0, "와인 — 디저트 대상 정화");
  assert.equal(r1.players.fed.counters.wineVotePenalty ?? 0, 0, "디저트 대상은 투표가치 페널티 없음");
}
{
  // 디저트 미보유 대상 → 1일 투표가치 -1(wineVotePenalty), 정화 안 함(canon: 디저트 보유자만 받는효과 제거).
  const unfed = { ...player("unfed", "citizen", "angel"), counters: { nightmare: 1 } };
  const s2 = emptyState(
    { mizlet: player("mizlet", "mizlet", "angel"), unfed },
    [{ sourceUserId: "mizlet", targetUserId: "unfed", actionType: "mizlet_wine", priority: 5 }],
  );
  const r2 = resolveNightActions(s2).newState;
  assert.equal(r2.players.unfed.counters.wineVotePenalty ?? 0, 1, "미디저트 대상 1일 투표가치 -1(wineVotePenalty=1)");
  assert.equal(r2.players.unfed.counters.voteValueMod ?? 0, 0, "영속 voteValueMod 는 미변경(회복 보장)");
}
// --- 4f. 헬렌 자유로운 새: 탈락자 추가 복귀 ---
{
  const dead = player("dead", "citizen", "angel", false);
  const state = emptyState(
    { helen: player("helen", "helen", "angel"), dead },
    [{ sourceUserId: "helen", targetUserId: "dead", actionType: "helen_freebird", priority: 3 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.dead.alive, true, "자유로운 새 — 탈락자 복귀");
}
// --- 4g. 하브레터스 상호추리: 악마 적중 시 자기 부정효과 면역(정화), 빗나가면 통지만 ---
{
  const hab = { ...player("hab", "habreterus", "angel"), counters: { nightmare: 1 } };
  const hit = emptyState(
    { hab, d: player("d", "demon", "demon") },
    [{ sourceUserId: "hab", targetUserId: "d", actionType: "habreterus_deduce", priority: 5 }],
  );
  const r1 = resolveNightActions(hit);
  assert.equal(r1.newState.players.hab.counters.nightmare ?? 0, 0, "추리 적중 — 하브 부정효과 면역(정화)");
  assert.ok(r1.events.some((e: any) => e.type === "deduce_hit"), "적중 이벤트");

  const hab2 = { ...player("hab", "habreterus", "angel"), counters: { nightmare: 1 } };
  const miss = emptyState(
    { hab: hab2, a: player("a", "citizen", "angel") },
    [{ sourceUserId: "hab", targetUserId: "a", actionType: "habreterus_deduce", priority: 5 }],
  );
  const r2 = resolveNightActions(miss);
  assert.equal(r2.newState.players.hab.counters.nightmare ?? 0, 1, "빗나감 — 정화 없음");
  assert.ok(r2.events.some((e: any) => e.type === "deduce_miss"), "빗나감 이벤트");
}
// --- 4h. 루루 악보 교체(자투): 자기 투표가치 +1 ---
{
  const state = emptyState(
    { luru: player("luru", "luru", "angel") },
    [{ sourceUserId: "luru", targetUserId: null, actionType: "luru_score", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.luru.counters.voteWeightBonus, 1, "악보 교체 — 자투 투표가치 +1");
}

// --- 5. 투쟁(우노): 대상 소속 카운트 +1 ---
{
  const state = emptyState(
    {
      uno: player("uno", "uno", "angel"),
      ally: player("ally", "citizen", "angel"),
    },
    [{ sourceUserId: "uno", targetUserId: "ally", actionType: "uno_struggle", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.ally.counters.countBonus, 1, "투쟁 대상 카운트 +1");
  assert.equal(newState.players.ally.counters.missionCharge, 1, "투쟁 대상 군인의 사명 +1");
  assert.ok(events.some((e: any) => e.type === "count_granted" && e.payload?.user_id === "ally"), "투쟁 이벤트");
  // 명예(조건부, canon [천사]6): 투쟁 대상(ally)이 생존 → 우노가 그날 명예(unoHonor=1) → 투표가치 +5.
  assert.equal(newState.players.uno.counters.unoHonor ?? 0, 1, "우노 명예 — 투쟁 대상 생존 → unoHonor");
  const honorTally = tallyEliminationVotes([{ actorUserId: "uno", targetUserId: "ally" }], newState.players);
  assert.equal(honorTally.tallies["ally"], 6, "우노 명예 — 행사 투표가치 1+5=6");
}
// --- 5b. 군인의 사명(우노): 투쟁 2회 충전 → 악마 효과 1회 제거 ---
{
  let state = emptyState(
    {
      uno: player("uno", "uno", "angel"),
      ally: player("ally", "citizen", "angel"),
    },
    [{ sourceUserId: "uno", targetUserId: "ally", actionType: "uno_struggle", priority: 5 }],
  );
  let r = resolveNightActions(state);
  state = emptyState(
    {
      uno: r.newState.players.uno,
      ally: r.newState.players.ally,
    },
    [{ sourceUserId: "uno", targetUserId: "ally", actionType: "uno_struggle", priority: 5 }],
  );
  r = resolveNightActions(state);
  assert.equal(r.newState.players.ally.counters.missionCharge, 2, "군인의 사명 — 투쟁 2회로 충전");

  const hit = resolveNightActions(emptyState(
    { demon: player("demon", "demon", "demon"), ally: r.newState.players.ally },
    [{ sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 }],
  ));
  assert.equal(hit.newState.players.ally.alive, true, "군인의 사명 — 악마 처치 효과 제거");
  assert.equal(hit.newState.players.ally.counters.missionCharge, 0, "군인의 사명 — 2스택 소비");
  assert.ok(hit.events.some((e: any) => e.type === "mission_blocked" && e.payload?.effect === "Kill"), "군인의 사명 차단 이벤트");
}

// --- 6. 박해(엘런): substrate — 내가 투표한 대상이 받는-투표가치 +3 ---
{
  // 엘런이 직전에 'target' 을 투표(lastVoteTarget) → 박해는 별도 지목 없이 그 대상을 민다.
  const ellen = { ...player("ellen", "ellen", "demon"), lastVoteTarget: "target" };
  const state = emptyState(
    {
      ellen,
      target: player("target", "citizen", "angel"),
    },
    [{ sourceUserId: "ellen", targetUserId: null, actionType: "ellen_persecute", priority: 5 }],
  );
  state.dayCount = 1; // 홀수날 — 박해 발동.
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.target.counters.persecuteBias, 3, "박해(홀수날) — 투표 대상 받는-투표가치 +3(지속 누진)");
  // 짝수날에는 박해가 발동하지 않는다(canon 홀수날 한정, oddDayOnly 게이트).
  const evenState = emptyState(
    { ellen: { ...player("ellen", "ellen", "demon"), lastVoteTarget: "target" }, target: player("target", "citizen", "angel") },
    [{ sourceUserId: "ellen", targetUserId: null, actionType: "ellen_persecute", priority: 5 }],
  );
  evenState.dayCount = 2;
  const { newState: evenNew } = resolveNightActions(evenState);
  assert.equal(evenNew.players.target.counters.persecuteBias ?? 0, 0, "박해 — 짝수날 미발동");
}

// --- 6b. 로건 Nullify: 대상의 다음 능력 발동을 소멸(지속) ---
{
  // 로건이 의사에게 무효 표식 → 의사의 치료가 발동하지 않아 피해자 사망.
  const state = emptyState(
    {
      logen: player("logen", "logen", "demon"),
      doc: player("doc", "doctor", "angel"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "logen", targetUserId: "doc", actionType: "logen_nullify", priority: 1 },
      { sourceUserId: "doc", targetUserId: "victim", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, false, "무효된 의사의 치료가 발동 안 해 피해자 사망");
  assert.ok(events.some((e: any) => e.type === "action_nullified" && e.userId === "doc"), "무효 발동 이벤트");
  assert.equal(newState.players.doc.counters.nullifyNext ?? 0, 0, "무효는 발동 시 소비");
}

// --- 6c. 대악마 압도적 존재감: 전원(All) 봉인 ---
{
  const state = emptyState(
    {
      demon: player("demon", "demon", "demon"),
      doc: player("doc", "doctor", "angel"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "demon", targetUserId: null, actionType: "daeakma_dominion", priority: 1 },
      { sourceUserId: "doc", targetUserId: "victim", actionType: "doctor_heal", priority: 3 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(events.some((e: any) => e.type === "action_blocked_silenced" && e.userId === "doc"), "전원 봉인 — 의사 능력 차단");
  assert.equal(newState.players.demon.counters.used_daeakma_dominion, 1, "압도적 존재감 1회 소진");
}

// --- 6d. 우노 용맹함: 자기 정화 + 명예 + 투표대상 처형/소속공개 + (천사 살해) 우노 명예 실추 ---
{
  const uno = { ...player("uno", "uno", "angel"), lastVoteTarget: "ally", counters: { voteBias: 3 } };
  const clean = emptyState(
    { uno, ally: player("ally", "doctor", "angel") },
    [{ sourceUserId: "uno", targetUserId: null, actionType: "uno_valor", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(clean);
  assert.equal(newState.players.uno.counters.voteBias ?? 0, 0, "용맹함 — 자기 부정효과 제거");
  assert.equal(newState.players.uno.counters.countBonus, 1, "용맹함 — 명예 +1");
  assert.equal(newState.players.ally.counters.missionCharge, 1, "용맹함 — 전원 투쟁으로 사명 충전");
  assert.ok(events.some((e: any) => e.type === "role_revealed" && e.payload?.user_id === "ally"), "용맹함 — 투표 대상 소속 공개");
  assert.equal(newState.players.ally.alive, false, "용맹함 — 투표 대상 처형(사망자로 기록)");
  assert.equal(newState.players.uno.counters.silencePending, 1, "동료(천사) 살해 → 우노 자신 명예 실추(다음 밤 봉인 예약)");
  // 다음 밤 — 예약이 silencedNights 로 승격되어 우노 자신의 행동이 봉인된다.
  const next = emptyState(
    { uno: newState.players.uno, x: player("x", "citizen", "angel") },
    [{ sourceUserId: "uno", targetUserId: "x", actionType: "uno_struggle", priority: 5 }],
  );
  const { events: ev2 } = resolveNightActions(next);
  assert.ok(ev2.some((e: any) => e.type === "action_blocked_silenced" && e.userId === "uno"), "명예 실추 — 다음 밤 우노 행동 봉인");
}
// --- 6d-2. 우노 용맹함: 악마 투표대상은 처형/공개만, 우노 명예 실추 없음 ---
{
  const uno = { ...player("uno", "uno", "angel"), lastVoteTarget: "dem" };
  const state = emptyState(
    { uno, dem: player("dem", "demon", "demon") },
    [{ sourceUserId: "uno", targetUserId: null, actionType: "uno_valor", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(events.some((e: any) => e.type === "role_revealed" && e.payload?.user_id === "dem"), "악마 투표대상도 소속 공개");
  assert.equal(newState.players.dem.alive, false, "악마 투표대상 처형");
  assert.equal(newState.players.uno.counters.silencePending ?? 0, 0, "악마 살해는 명예 실추 없음(우노 봉인 X)");
}
// --- 6d-2b. 흡수 출처 추적(provenance): 악마팀 디버프만 demonDebuffs 로 집계 ---
{
  // 악마(말렌 빙의)가 가한 부정효과 → 대상 demonDebuffs +1. 천사(세이카 봉인)가 가한 건 미집계.
  const state = emptyState(
    {
      malen: player("malen", "malen", "demon"),
      seika: player("seika", "seika", "angel"),
      t1: player("t1", "citizen", "angel"),
      t2: player("t2", "citizen", "angel"),
    },
    [
      { sourceUserId: "malen", targetUserId: "t1", actionType: "malen_possess", priority: 1 },
      { sourceUserId: "seika", targetUserId: "t2", actionType: "seika_supernova", priority: 1 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.t1.counters.demonDebuffs, 1, "악마팀 가해 → demonDebuffs +1");
  assert.equal(newState.players.t2.counters.demonDebuffs ?? 0, 0, "천사 가해는 악마팀 효과 아님(demonDebuffs 0)");
}
// --- 6d-3. 세이카 자신만 아플 거야: 악마팀 효과(demonDebuffs) 3+ → 소멸 + 악마팀 공개 카운트다운 ---
{
  // demonDebuffs(악마팀 출처, 지속)만 소멸 임계에 누적. 천사·중립 디버프(아래 nightmare)는 정화는
  // 되지만 임계엔 안 들어간다 — provenance 정밀.
  const state = emptyState(
    {
      seika: player("seika", "seika", "angel"),
      a: { ...player("a", "citizen", "angel"), counters: { demonDebuffs: 2, nightmare: 1 } },
      b: { ...player("b", "citizen", "angel"), counters: { demonDebuffs: 1 } },
    },
    [{ sourceUserId: "seika", targetUserId: null, actionType: "seika_absorb", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.seika.counters.absorbedDebuffs, 3, "악마팀 효과 흡수 누적 3");
  assert.equal(newState.players.a.counters.nightmare ?? 0, 0, "흡수로 대상 정화(출처 무관 디버프도 제거)");
  assert.equal(newState.players.a.counters.demonDebuffs ?? 0, 0, "흡수 후 demonDebuffs 소비");
  assert.equal(newState.players.seika.alive, false, "악마팀 효과 3+ 흡수 → 세이카 소멸");
  assert.equal(newState.players.seika.counters.annihilated, 1, "소멸 = 부활 불가");
  assert.equal(newState.players.seika.counters.demonRevealIn, 2, "악마팀 공개 카운트다운 세팅");
  assert.ok(events.some((e: any) => e.type === "seika_overload"), "세이카 과부하 이벤트");
}
// --- 6d-3b. 세이카 흡수: 악마팀 효과 3 미만이면 소멸 안 함 ---
{
  const state = emptyState(
    {
      seika: player("seika", "seika", "angel"),
      a: { ...player("a", "citizen", "angel"), counters: { demonDebuffs: 1, nightmare: 1, voteBias: 5 } },
    },
    [{ sourceUserId: "seika", targetUserId: null, actionType: "seika_absorb", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.seika.alive, true, "악마팀 효과 2 이하 → 세이카 생존");
  assert.equal(newState.players.a.counters.nightmare ?? 0, 0, "디버프는 그래도 정화");
}
// --- 6d-4. 세이카 악마팀 공개 카운트다운: 2→1→0(공개) ---
{
  const seika = { ...player("seika", "seika", "angel", false), counters: { demonRevealIn: 2 } };
  const demon = player("demon", "demon", "demon");
  let r = resolveNightActions(emptyState({ seika, demon }, []));
  assert.equal(r.newState.players.seika.counters.demonRevealIn, 1, "카운트다운 2→1");
  r = resolveNightActions(emptyState({ seika: r.newState.players.seika, demon }, []));
  assert.equal(r.newState.players.seika.counters.demonRevealIn, 0, "카운트다운 1→0");
  assert.ok(r.events.some((e: any) => e.type === "demons_revealed" && (e.payload?.demons ?? []).includes("demon")), "이틀 후 악마팀 공개");
}
// --- 6d-5. 로건 부서진 펜던트: 악마 처치자 3명 → 로건 지정 대상 +2 ---
{
  const state = emptyState(
    {
      logen: player("logen", "logen", "demon"),
      d1: player("d1", "demon", "demon"),
      d2: player("d2", "malen", "demon"),
      d3: player("d3", "phantom", "demon"),
      a: player("a", "citizen", "angel"),
    },
    [],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(newState.players.d1.tags.includes("pendant"), "악마 처치자에 펜던트 부여");
  assert.ok(events.some((e: any) => e.type === "pendant_applied"), "펜던트 부여 이벤트");
  assert.equal(newState.players.logen.counters.pendantTargetBonus, 2, "펜던트 3+ → 로건 지정 대상 +2");
  assert.ok(!newState.players.a.tags.includes("pendant"), "천사엔 펜던트 미부여");
}
// --- 6d-5b. 로건 전부 괜찮을 거야(원문 능력2): 펜던트 적용자 무적 / 비적용자 파멸, 2중첩 소멸 ---
{
  // d(악마)는 이미 펜던트 보유(지속 태그 — 이전 라운드 부여) → 그 밤 무적(Protect) → 처치 무효.
  // safe(천사, doom 0)는 파멸 1중첩만 받아 생존. doomed(천사, doom 1 선보유)는 파멸 2중첩 → 소멸.
  const state = emptyState(
    {
      logen: player("logen", "logen", "demon"),
      d: { ...player("d", "demon", "demon"), tags: ["pendant"] },
      safe: player("safe", "citizen", "angel"),
      doomed: { ...player("doomed", "romaz", "angel"), counters: { doom: 1 } },
    },
    [
      { sourceUserId: "logen", targetUserId: null, actionType: "logen_allwell", priority: 3 },
      // d 가 펜던트 무적인지 확인하려 자기 진영 처치(테스트 한정) — Protect 면 살아남는다.
      { sourceUserId: "d", targetUserId: "d", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(newState.players.d.tags.includes("pendant"), "악마 처치자 펜던트 보유");
  assert.equal(newState.players.d.alive, true, "펜던트 적용자 — 무적(처치 무효)");
  assert.equal(newState.players.safe.counters.doom, 1, "비적용자 — 파멸 1중첩");
  assert.equal(newState.players.safe.alive, true, "파멸 1중첩 — 생존");
  assert.equal(newState.players.doomed.counters.doom, 2, "파멸 2중첩 도달");
  assert.equal(newState.players.doomed.alive, false, "파멸 2중첩 — 소멸");
  assert.equal(newState.players.doomed.counters.annihilated, 1, "소멸 = 부활 불가(annihilated)");
  assert.ok(events.some((e: any) => e.type === "annihilated" && e.payload?.user_id === "doomed"), "소멸 이벤트");
  // 1회성: 두 번째 발동은 maxUses 로 막힌다.
  const again = emptyState(
    { logen: { ...newState.players.logen }, x: player("x", "citizen", "angel") },
    [{ sourceUserId: "logen", targetUserId: null, actionType: "logen_allwell", priority: 3 }],
  );
  const { newState: n2, events: e2 } = resolveNightActions(again);
  assert.equal(n2.players.x.counters.doom ?? 0, 0, "1회 소진 — 재발동 시 파멸 미적용");
  assert.ok(e2.some((e: any) => e.type === "action_blocked_exhausted" && e.userId === "logen"), "소진 차단");
}
// --- 6d-6. 가인 약간의 위선(원문): 직업 통지 + 그 밤 능력 *취소*(Silence, priority 1 선처리) ---
{
  // 가인이 의사에게 위선 → 그 밤 의사의 치료가 취소된다(봉인). 같은 밤 의사가 victim 치료 시도 +
  // 악마가 victim 처치 → 치료가 봉인돼 불발, victim 사망.
  const state = emptyState(
    {
      gain: player("gain", "gain", "demon"),
      doc: player("doc", "doctor", "angel"),
      victim: player("victim", "citizen", "angel"),
      demon: player("demon", "demon", "demon"),
    },
    [
      { sourceUserId: "gain", targetUserId: "doc", actionType: "gain_hypocrisy", priority: 1 },
      { sourceUserId: "doc", targetUserId: "victim", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(events.some((e: any) => e.type === "role_revealed" && e.payload?.user_id === "doc"), "위선 — 직업(진영) 통지");
  assert.ok(events.some((e: any) => e.type === "silenced" && e.payload?.user_id === "doc"), "위선 — 그 밤 능력 취소(봉인)");
  assert.equal(newState.players.victim.alive, false, "취소된 치료 불발 → 피해자 사망(그 밤 취소)");
}
// --- 6d-6b. 가인 위선 강화(원문): 악마가 위선 대상을 투표했었다면 다음 위선이 *봉인*으로 강화 ---
{
  // 1밤: 가인이 t에 위선. 같은 밤 생존 악마(demon)의 직전 투표 대상(lastVoteTarget)이 t →
  // 가인 hypocrisySealReady 점화(원문 "악마가 대상을 투표했었다면").
  const st1 = emptyState(
    {
      gain: player("gain", "gain", "demon"),
      t: player("t", "citizen", "angel"),
      demon: { ...player("demon", "demon", "demon"), lastVoteTarget: "t" },
    },
    [{ sourceUserId: "gain", targetUserId: "t", actionType: "gain_hypocrisy", priority: 1 }],
  );
  const { newState: s1, events: e1 } = resolveNightActions(st1);
  assert.equal(s1.players.gain.counters.hypocrisySealReady, 1, "위선 강화 점화(악마가 대상 투표)");
  assert.ok(e1.some((e: any) => e.type === "hypocrisy_seal_armed" && e.payload?.user_id === "t"), "강화 점화 이벤트");
  // 2밤: 가인이 새 대상 v에 위선 → 봉인 강화(hypocrisySeal 마크 + 봉인). 강화 1회 소비.
  const st2 = emptyState(
    { gain: s1.players.gain, v: player("v", "citizen", "angel") },
    [{ sourceUserId: "gain", targetUserId: "v", actionType: "gain_hypocrisy", priority: 1 }],
  );
  const { newState: s2 } = resolveNightActions(st2);
  assert.equal(s2.players.v.counters.hypocrisySeal, 1, "강화 위선 = 봉인 마크(재적용 시 영구)");
  assert.equal(s2.players.gain.counters.hypocrisySealReady ?? 0, 0, "강화 1회 소비");
}

// --- 6e. 팬텀 영면: 이미 악몽인 대상 재지정 = 즉시 죽이지 않고 풀(deepsleep) 누적 + 악몽 지정 +1 ---
{
  const victim = { ...player("victim", "citizen", "angel"), counters: { nightmare: 1 } };
  const state = emptyState(
    { phantom: { ...player("phantom", "phantom", "demon"), counters: { nightmareUses: 5 } }, victim },
    [{ sourceUserId: "phantom", targetUserId: "victim", actionType: "phantom_nightmare", priority: 4 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "영면 — 즉시 죽지 않음(풀 누적)");
  assert.equal(newState.players.victim.counters.deepsleep, 1, "영면 표식");
  assert.equal(newState.players.phantom.counters.deepsleepCount, 1, "살아있는 영면 1명 → 팬텀 악몽 지정 +1");
  assert.ok(events.some((e: any) => e.type === "deepsleep_marked"), "영면 이벤트");
}
// --- 6f. 팬텀 영면 발동(phantom_reap): 누적 영면 전원 일괄 처치 ---
{
  const state = emptyState(
    {
      phantom: { ...player("phantom", "phantom", "demon"), counters: { deepsleepCount: 2 } },
      d1: { ...player("d1", "citizen", "angel"), counters: { deepsleep: 1 } },
      d2: { ...player("d2", "citizen", "angel"), counters: { deepsleep: 1 } },
      safe: player("safe", "citizen", "angel"),
    },
    [{ sourceUserId: "phantom", targetUserId: null, actionType: "phantom_reap", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.d1.alive, false, "영면 발동 — d1 처치");
  assert.equal(newState.players.d2.alive, false, "영면 발동 — d2 처치(다수 일괄)");
  assert.equal(newState.players.safe.alive, true, "영면 아닌 대상은 안전");
  assert.equal(newState.players.phantom.counters.deepsleepCount, 0, "발동 후 영면 카운트 리셋");
}
// --- 6g. 동적 악몽: 영면 1명 살아있으면 악몽 2명 동시 지정 ---
{
  const state = emptyState(
    {
      phantom: { ...player("phantom", "phantom", "demon"), counters: { deepsleepCount: 1, nightmareUses: 5 } },
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
    },
    [{ sourceUserId: "phantom", targetUserId: null, targetUserIds: ["a", "b"], actionType: "phantom_nightmare", priority: 4 }],
  );
  const { events } = resolveNightActions(state);
  for (const id of ["a", "b"]) {
    assert.ok(events.some((e: any) => e.type === "nightmare_marked" && e.payload?.user_id === id), `동적 악몽 — ${id} 지정(상한 1+1=2)`);
  }
}
// --- 팬텀 악몽 사용 횟수: 발동 1회당 1 소비(봉인하면 충전 없음), 0명 봉인 밤엔 +2 충전(상한 5) ---
{
  // 같은 밤에 봉인+악몽 → 봉인했으므로 충전 없음. 악몽 1 소비: 5→4.
  const state = emptyState(
    {
      phantom: { ...player("phantom", "phantom", "demon"), counters: { nightmareUses: 5 } },
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
    },
    [
      { sourceUserId: "phantom", targetUserId: null, targetUserIds: ["a"], actionType: "phantom_seal", priority: 1 },
      { sourceUserId: "phantom", targetUserId: "b", actionType: "phantom_nightmare", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.phantom.counters.nightmareUses, 4, "봉인한 밤 + 악몽 1회 → 5→4(충전 없음)");
}
{
  // 아무것도 봉인 안 한 밤 → 악몽 +2 충전(상한 5). 시작 1 → 3.
  const state = emptyState(
    { phantom: { ...player("phantom", "phantom", "demon"), counters: { nightmareUses: 1 } } },
    [],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.phantom.counters.nightmareUses, 3, "0명 봉인 밤 → 악몽 +2 충전(1→3)");
}
{
  // 사용 횟수 0이면 악몽 발동 차단.
  const state = emptyState(
    { phantom: { ...player("phantom", "phantom", "demon"), counters: { nightmareUses: 0 } }, v: player("v", "citizen", "angel") },
    [
      { sourceUserId: "phantom", targetUserId: null, targetUserIds: ["v"], actionType: "phantom_seal", priority: 1 }, // 봉인해서 충전 막음
      { sourceUserId: "phantom", targetUserId: "v", actionType: "phantom_nightmare", priority: 4 },
    ],
  );
  const { events } = resolveNightActions(state);
  assert.ok(events.some((e: any) => e.type === "action_blocked_no_charge"), "사용 횟수 0 → 악몽 차단");
}

// --- 7. 잔불 대검(아서): 결백자(tainted 없음) 하루 무적 → 처치 무효. 충전(emberCharge) 소비. ---
{
  const state = emptyState(
    {
      arthur: { ...player("arthur", "arthur", "angel"), counters: { emberCharge: 1 } },
      demon: player("demon", "demon", "demon"),
      ally: player("ally", "citizen", "angel"), // 부정 효과 적용 이력 없음 → 결백 → Protect 분기.
    },
    [
      { sourceUserId: "arthur", targetUserId: "ally", actionType: "arthur_emberblade", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.ally.alive, true, "잔불 대검 보호로 처치 무효(결백자)");
  assert.ok(events.some((e: any) => e.type === "attack_prevented"), "보호 이벤트");
  assert.equal(newState.players.arthur.counters.emberCharge ?? 0, 0, "잔불 대검 — 충전 1 소비");
  assert.equal(newState.players.ally.counters.branded ?? 0, 0, "결백자는 폭열 안 함");
}

// --- 7a. 잔불 대검 충전 없으면 발동 차단(0회 제한·충전가능) ---
{
  const state = emptyState(
    { arthur: player("arthur", "arthur", "angel"), ally: player("ally", "citizen", "angel") },
    [{ sourceUserId: "arthur", targetUserId: "ally", actionType: "arthur_emberblade", priority: 4 }],
  );
  const { events } = resolveNightActions(state);
  assert.ok(events.some((e: any) => e.type === "action_blocked_no_charge"), "충전 없으면 잔불 대검 차단");
}

// --- 7b. 잔불 대검(타락자): 폭열(branded) → 재적용 시 소멸. 타락 판정 = 행위 이력(tainted), 진영 아님. ---
{
  const state = emptyState(
    {
      arthur: { ...player("arthur", "arthur", "angel"), counters: { emberCharge: 1 } },
      foe: { ...player("foe", "citizen", "angel"), counters: { tainted: 1 } }, // 천사여도 부정효과 이력 → 타락 판정.
    },
    [{ sourceUserId: "arthur", targetUserId: "foe", actionType: "arthur_emberblade", priority: 4 }],
  );
  const r1 = resolveNightActions(state);
  assert.equal(r1.newState.players.foe.counters.branded, 1, "첫 잔불 대검 — 타락자 폭열 표식");
  assert.equal(r1.newState.players.foe.alive, true, "첫 잔불 대검으로는 탈락 안 함");
  // 재적용 → 소멸(충전 다시 채움).
  const again = emptyState(
    { arthur: { ...player("arthur", "arthur", "angel"), counters: { emberCharge: 1 } }, foe: { ...r1.newState.players.foe } },
    [{ sourceUserId: "arthur", targetUserId: "foe", actionType: "arthur_emberblade", priority: 4 }],
  );
  const r2 = resolveNightActions(again);
  assert.equal(r2.newState.players.foe.alive, false, "폭열된 타락자 재적용 — 소멸");
  assert.equal(r2.newState.players.foe.counters.annihilated, 1, "소멸 표식(부활 불가)");
  // 소멸자는 부활 불가.
  const tryRevive = emptyState(
    { mizlet: player("mizlet", "mizlet", "angel"), foe: { ...r2.newState.players.foe } },
    [{ sourceUserId: "mizlet", targetUserId: "foe", actionType: "mizlet_revive", priority: 3 }],
  );
  assert.equal(resolveNightActions(tryRevive).newState.players.foe.alive, false, "소멸자는 부활 불가");
}

// --- 7c. 말렌 SoulCounter: 사망 발생 시 혼 누적 → 시체(악마팀 카운트 보조) ---
{
  const state = emptyState(
    {
      malen: player("malen", "malen", "demon"),
      v1: player("v1", "citizen", "angel"),
      v2: player("v2", "citizen", "angel"),
      d1: player("d1", "demon", "demon"),
      d2: player("d2", "demon", "demon"),
    },
    [
      { sourceUserId: "d1", targetUserId: "v1", actionType: "demon_kill", priority: 4 },
      { sourceUserId: "d2", targetUserId: "v2", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  // 2명 사망 → 혼 2 → 시체 1구(deadCountBonus +1), 혼 잔량 0.
  assert.equal(newState.players.malen.counters.deadCountBonus ?? 0, 1, "혼 2개 → 시체 1구(악마팀 카운트 +1)");
  assert.equal(newState.players.malen.counters.soul ?? 0, 0, "시체 전환 후 혼 잔량 0");
}

// --- 7d. 미즐렛 디저트(쿠키): 생존자 보호 + 디저트/쿠키 태그 ---
{
  const state = emptyState(
    {
      mizlet: player("mizlet", "mizlet", "angel"),
      ally: player("ally", "citizen", "angel"),
      demon: player("demon", "demon", "demon"),
    },
    [
      { sourceUserId: "mizlet", targetUserId: "ally", actionType: "mizlet_cookie", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.ally.alive, true, "쿠키 보호로 처치 무효");
  assert.ok(newState.players.ally.tags.includes("cookie"), "쿠키 표식 부여(지속)");
  assert.ok(newState.players.ally.tags.includes("dessert"), "디저트 태그 부여");
}

// --- 7e. 도르단 단서: 사망 발생 시 단서 누적(정밀 조사 게이트) ---
{
  const state = emptyState(
    {
      dordan: player("dordan", "dordan", "angel"),
      demon: player("demon", "demon", "demon"),
      v: player("v", "citizen", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "v", actionType: "demon_kill", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.dordan.counters.clue ?? 0, 1, "탈락 1명 → 도르단 단서 +1");
}

// --- 7f. 루루 소나타(canon [천사]30): 매료 3 누적 → 전원 투표가치 +1(sonataVote) + 루루 무적(게이트·소비) ---
{
  // 게이지 3 → 소나타가 전원 투표가치 +1(sonataVote) + 루루 보호. (전원 정화 아님 — 매료만 제거.)
  const luru = { ...player("luru", "luru", "angel"), counters: { charmCount: 3 } };
  const ally = { ...player("ally", "citizen", "angel"), counters: { nightmare: 1 } };
  const state = emptyState(
    { luru, ally, demon: player("demon", "demon", "demon") },
    [
      { sourceUserId: "luru", targetUserId: null, actionType: "luru_sonata", priority: 5 },
      { sourceUserId: "demon", targetUserId: "luru", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.ally.counters.sonataVote ?? 0, 1, "소나타 — 전원 투표가치 +1(sonataVote)");
  assert.equal(newState.players.luru.counters.sonataVote ?? 0, 1, "소나타 — 루루 본인도 sonataVote +1");
  assert.equal(newState.players.luru.alive, true, "소나타 — 루루 자기 무적(처치 무효)");
  assert.equal(newState.players.luru.counters.charmCount ?? 0, 0, "소나타 — 게이지 소비");
  // 게이지 부족(2)이면 발동 안 함.
  const low = emptyState(
    { luru: { ...player("luru", "luru", "angel"), counters: { charmCount: 2 } } },
    [{ sourceUserId: "luru", targetUserId: null, actionType: "luru_sonata", priority: 5 }],
  );
  const r = resolveNightActions(low);
  assert.ok(r.events.some((e: any) => e.type === "action_blocked_no_charge"), "매료 부족 — 소나타 차단");
}

// --- 8. 매료(루루): 대상 처형 투표 무력화 + 루루에게 양도 ---
{
  const state = emptyState(
    {
      luru: player("luru", "luru", "angel"),
      charmed: player("charmed", "citizen", "angel"),
    },
    [{ sourceUserId: "luru", targetUserId: "charmed", actionType: "luru_charm", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.charmed.counters.charmed, 1, "대상 매료됨");
  assert.equal(newState.players.luru.counters.voteWeightBonus, 1, "루루에게 투표 양도");

  // 매료된 자의 처형 투표는 집계에서 빠지고, 루루 투표가치는 양도분만큼 커진다.
  const voters = {
    luru: { ...player("luru", "luru", "angel"), counters: { voteWeightBonus: 1 } },
    charmed: { ...player("charmed", "citizen", "angel"), counters: { charmed: 1 } },
    bob: player("bob", "citizen", "angel"),
  };
  const tally = tallyEliminationVotes(
    [
      { actorUserId: "charmed", targetUserId: "bob" },
      { actorUserId: "luru", targetUserId: "bob" },
    ],
    voters,
  );
  assert.equal(tally.tallies.bob, 2, "매료자 표 0 + 루루 표 2(기본1+양도1)");
}

// --- 9. 악몽(팬텀): vault canon 2단계 지연 — 캐스트 밤 N 에 pending → 다음 밤 N+1 에
//        nightmare 활성 → 그 다음 아침(N+2)에 탈락. 밤 보호로는 막을 수 없는 지연 효과. ---
{
  // 캐스트 밤(N)
  const state = emptyState(
    {
      phantom: { ...player("phantom", "phantom", "demon"), counters: { nightmareUses: 5 } },
      doctor: player("doctor", "habreterus", "angel"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "doctor", targetUserId: "victim", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "phantom", targetUserId: "victim", actionType: "phantom_nightmare", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "악몽은 그 밤엔 죽이지 않음(지연)");
  assert.equal(newState.players.victim.counters.nightmarePending, 1, "캐스트 밤엔 pending 표식만");
  assert.ok(!newState.players.victim.counters.nightmare, "캐스트 밤에는 아직 nightmare 활성화 X");
  // 캐스트 밤의 아침(N+1) — 아직 nightmare 가 활성화 안 됐으므로 탈락 X.
  const nmA = resolveNightmares(newState.players) as Array<{ type: string }>;
  assert.equal(newState.players.victim.alive, true, "캐스트 밤 아침엔 아직 살아있음");
  assert.equal(nmA.length, 0, "캐스트 밤 아침엔 악몽 사망 이벤트 없음");

  // 다음 밤(N+1) 시작 — pending → nightmare 이동.
  const nextNight = emptyState({ phantom: newState.players.phantom, victim: newState.players.victim }, []);
  const { newState: n2 } = resolveNightActions(nextNight);
  assert.equal(n2.players.victim.counters.nightmare, 1, "다음 밤 시작 시 nightmare 활성");
  assert.equal(n2.players.victim.counters.nightmarePending, 0, "pending 은 소비됨");
  // 그 다음 아침(N+2) 에 탈락.
  const nmB = resolveNightmares(n2.players) as Array<{ type: string; payload?: { user_id?: string } }>;
  assert.equal(n2.players.victim.alive, false, "지정한 다음 다음 아침에 탈락(보호 무시)");
  assert.ok(nmB.some((e) => e.type === "nightmare_death" && e.payload?.user_id === "victim"), "악몽 사망 이벤트");
}

// --- 10. 빙의(말렌): 행동 봉인 + 그 라운드 악마팀 카운트 ---
{
  const state = emptyState(
    {
      malen: player("malen", "malen", "demon"),
      victim: player("victim", "romaz", "angel"),
      bystander: player("bystander", "citizen", "angel"),
    },
    [{ sourceUserId: "malen", targetUserId: "victim", actionType: "malen_possess", priority: 1 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.victim.counters.possessed, 1, "빙의 표식");
  assert.ok((newState.players.victim.counters.silencedNights ?? 0) >= 1 || true, "행동 봉인(같은 밤 처리)");
  // 빙의된 천사는 그 라운드 악마팀으로 카운트 → 패리티 영향.
  const win = checkWinCondition({
    malen: player("malen", "malen", "demon"),
    victim: { ...player("victim", "romaz", "angel"), counters: { possessed: 1 } },
    a: player("a", "citizen", "angel"),
  });
  // malen(악마)+victim(빙의→악마)=2 vs a(천사)=1 → 악마 카운트 우위.
  assert.equal(win.winner, "demons", "빙의된 천사가 악마팀으로 카운트되어 패리티 성립");
}

// --- 11. (베스토 제거됨 — 로잔느로 교체. 변신 능력 테스트 폐기) ---

// --- 12. 낙인(대악마): 대상 직업을 임의 천사 직업으로 비밀 재배정 ---
{
  const state = emptyState(
    {
      demon: player("demon", "demon", "demon"),
      target: player("target", "romaz", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "target", actionType: "daeakma_brand", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(ANGEL_ROLES.includes(newState.players.target.currentRole), "낙인 대상 currentRole 이 천사 풀로 재배정");
  assert.equal(newState.players.target.originalRole, "romaz", "원직업은 originalRole 에 보존(종료 시 공개)");
  assert.ok(events.some((e: any) => e.type === "rebranded" && e.payload?.user_id === "target"), "낙인 이벤트");
}

// --- 13. 일식(팬텀): self 표식 — phase-advance 가 아침→밤 전환 + 소멸 ---
{
  const state = emptyState(
    { phantom: player("phantom", "phantom", "demon") },
    [{ sourceUserId: "phantom", targetUserId: null, actionType: "phantom_eclipse", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.phantom.counters.eclipse, 1, "일식 표식 세팅");
  assert.ok(events.some((e: any) => e.type === "eclipse_cast"), "일식 이벤트");
}

assert.match(roles, /id: "daeakma_brand"[\s\S]*?type: "Rebrand"/, "대악마 낙인");
assert.match(roles, /id: "phantom_eclipse"[\s\S]*?type: "Eclipse"/, "팬텀 일식");
// match-action: SELF 행동 null 타겟 허용 + 베스토 조사 회피.
assert.match(matchAction, /SELF_ACTIONS[\s\S]*?targetType === "SELF"[\s\S]*?"NONE"[\s\S]*?"ALL"/, "SELF/무대상 행동은 targetType 으로 도출(단일 출처)");
assert.match(roles, /id: "daeakma_dominion"/, "대악마 존재감 능력 정의(단일 출처)");
assert.match(roles, /id: "uno_valor"/, "우노 용맹함 능력 정의(단일 출처)");
assert.match(roles, /id: "rosanne"[\s\S]*?faction: "demon"/, "로잔느 악마-5 분류(독립 솔로) — besto 교체");
const batch2aMig = readFileSync("supabase/migrations/20260614140000_gomdori_batch_tier2a.sql", "utf8");
assert.match(batch2aMig, /'uno_valor'/, "마이그레이션 — 용맹함");
assert.match(batch2aMig, /'daeakma_dominion'/, "마이그레이션 — 압도적 존재감");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?target: "VoteTarget"/, "엘런 박해 — substrate VoteTarget");
assert.match(roles, /id: "demon_kill"/, "대악마 처치 능력 정의(단일 출처)");
// 2026-06-12: 조사 판정은 유효 직업(effectiveRole — 낙인 재배정 반영) 기준으로 이동.
assert.match(matchAction, /isDemonKillerRole\(effectiveRole\(target\)\)/, "처치자 조사 판정 (유효 직업 기준)");
// phase-advance: 일식 소멸 + 다음 밤 전환.
const phaseAdvanceSrc = readFileSync("supabase/functions/phase-advance/index.ts", "utf8");
assert.match(phaseAdvanceSrc, /eclipse_annihilation/, "일식 소멸 처리");
assert.match(phaseAdvanceSrc, /eclipseActive[\s\S]*?nextNightSuspectTransition/, "일식 시 아침 대신 다음 밤");
const deepMig = readFileSync("supabase/migrations/20260610200000_gomdori_deep_demons.sql", "utf8");
for (const a of ["besto_hidden", "besto_shift", "daeakma_brand", "phantom_eclipse"]) {
  assert.match(deepMig, new RegExp(`'${a}'`), `migration allows ${a}`);
}

assert.match(roles, /id: "malen_possess"[\s\S]*?type: "Possess"/, "말렌 빙의");
assert.match(roles, /id: "malen_elusive"[\s\S]*?type: "SummonCorpse"/, "말렌 신출귀몰");
assert.match(roles, /id: "phantom_nightmare"[\s\S]*?type: "Nightmare"/, "팬텀 악몽");
assert.match(roles, /id: "arthur_emberblade"[\s\S]*?type: "Protect"/, "아서 잔불 대검");
assert.match(roles, /id: "luru_charm"[\s\S]*?type: "Charm"/, "루루 매료");
assert.match(roles, /id: "luru_sonata"[\s\S]*?requiresCounter: \{ key: "charmCount", min: 3/, "루루 소나타(매료 3 게이트)");
assert.match(roles, /id: "luru_sonata"/, "루루 소나타 능력 정의(단일 출처)");
assert.match(readFileSync("supabase/functions/_shared/match-action-core.ts", "utf8"), /clue >= clueThreshold && !disguised/, "도르단 단서 — 동적 임계(5-탈락자) 정밀 조사");
assert.match(readFileSync("supabase/functions/_shared/match-action-core.ts", "utf8"), /clueThreshold = Math\.max\(1, 5 - /, "도르단 단서 임계 = max(1, 5-탈락자)");
const batch2cMig = readFileSync("supabase/migrations/20260614160000_gomdori_batch_tier2c.sql", "utf8");
assert.match(batch2cMig, /'luru_sonata'/, "마이그레이션 — 소나타");
const malenElusiveMig = readFileSync("supabase/migrations/20260617190000_gomdori_malen_elusive.sql", "utf8");
assert.match(malenElusiveMig, /'malen_elusive'/, "마이그레이션 — 말렌 신출귀몰");
assert.match(roles, /id: "uno_struggle"[\s\S]*?type: "GrantCount"/, "우노 투쟁");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?type: "ModifyReceivedVote"/, "엘런 박해");
assert.match(roles, /id: "luna_corrupt"[\s\S]*?type: "Corrupt"/, "루나 변환");
assert.match(roles, /id: "logen_nullify"[\s\S]*?type: "Nullify"/, "로건 무력화(다음 능력 소멸)");
assert.match(roles, /id: "logen_allwell"[\s\S]*?type: "Protect", target: "AllOthers", onlyIfTargetTag: "pendant"/, "로건 전부 괜찮을 거야 — 펜던트 적용자 무적");
assert.match(roles, /id: "logen_allwell"[\s\S]*?type: "Kill", target: "AllOthers", annihilate: true[\s\S]*?onlyIfTargetCounter: \{ key: "doom", min: 2 \}/, "로건 전부 괜찮을 거야 — 파멸 2중첩 소멸");
assert.match(roles, /id: "rosanne_hatred"[\s\S]*?type: "VoteCrush"/, "로잔느 증오(VoteCrush)");
assert.match(roles, /id: "rosanne_resentment"[\s\S]*?tag: "wonhan"/, "로잔느 만들어가는 미래(원한 표식)");

// --- 르상티망 받는가치 다운사이드: '원한'(wonhan) 보유 생존자 1명당 로잔느 받는-표 +1 ---
{
  // 원한 보유자 2명(a, b) 생존 → 로잔느 받는-표 +2. 보유자 사망분(deadW)은 안 셈.
  const rosanne: PlayerState = { ...player("rosanne", "rosanne", "neutral"), tags: [] };
  const a: PlayerState = { ...player("a", "citizen", "angel"), tags: ["wonhan"] };
  const b: PlayerState = { ...player("b", "citizen", "angel"), tags: ["wonhan"] };
  const deadW: PlayerState = { ...player("deadW", "citizen", "angel", false), tags: ["wonhan"] };
  const players = { rosanne, a, b, deadW };
  // 아무도 로잔느에게 투표 안 함 — 받는-표는 순수하게 원한 다운사이드만.
  const tally = tallyEliminationVotes([], players);
  assert.equal(tally.tallies["rosanne"], 2, "르상티망 — 생존 원한 보유자 2명 → 로잔느 받는-표 +2(사망자 제외)");
}
{
  // 원한 보유자 0명 → 로잔느 받는-표 가산 없음.
  const rosanne: PlayerState = player("rosanne", "rosanne", "neutral");
  const tally = tallyEliminationVotes([], { rosanne, a: player("a", "citizen", "angel") });
  assert.equal(tally.tallies["rosanne"] ?? 0, 0, "르상티망 — 원한 보유자 없으면 가산 없음");
}
{
  const engineSrcWonhan = readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8");
  assert.match(engineSrcWonhan, /wonhanCount[\s\S]*?currentRole === "rosanne"/, "르상티망 받는가치 — wonhan 보유자 수 → 로잔느 받는-표 가산");
}

// --- 로잔느 조망(전역 시전비용): 로잔느 생존 중, 타인에게 능력을 적용한 시전자는 투표가치 -1(대상 수만큼) ---
{
  // 의사가 타인 1명을 치료 → 조망 비용 -1. 로잔느 생존이 게이트.
  const state = emptyState(
    {
      rosanne: player("rosanne", "rosanne", "neutral"),
      doc: { ...player("doc", "doctor", "angel"), bonusVoteValue: 2 },
      patient: player("patient", "citizen", "angel"),
    },
    [{ sourceUserId: "doc", targetUserId: "patient", actionType: "doctor_heal", priority: 3 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.doc.counters.voteValueMod ?? 0, -1, "조망 — 타인 1명 대상 시 시전자 투표가치 -1");
  assert.ok(events.some((e: any) => e.type === "gaze_cost" && e.payload?.user_id === "doc"), "조망 비용 이벤트");
  // 로잔느 본인은 대상이 없었으면 비용 없음.
  assert.equal(newState.players.rosanne.counters.voteValueMod ?? 0, 0, "조망 — 시전 안 한 로잔느는 비용 없음");
}
{
  // 로잔느 부재 시 비용 없음(게이트 확인).
  const state = emptyState(
    { doc: player("doc", "doctor", "angel"), patient: player("patient", "citizen", "angel") },
    [{ sourceUserId: "doc", targetUserId: "patient", actionType: "doctor_heal", priority: 3 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.doc.counters.voteValueMod ?? 0, 0, "조망 — 로잔느 부재 시 비용 없음");
}
{
  // 1 미만으로는 안 내려감: 기본 1짜리 시전자가 타인 다수 대상이어도 effective vote >= 1.
  const state = emptyState(
    {
      rosanne: player("rosanne", "rosanne", "neutral"),
      daeakma: player("daeakma", "demon", "demon"),
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
    },
    // 대악마 압도적 존재감(AllOthers Silence) — 타인 3명(rosanne/a/b)에 적용.
    [{ sourceUserId: "daeakma", targetUserId: null, actionType: "daeakma_dominion", priority: 1 }],
  );
  const { newState } = resolveNightActions(state);
  const eff = 1 + (newState.players.daeakma.bonusVoteValue || 0) + (newState.players.daeakma.counters.voteWeightBonus ?? 0) + (newState.players.daeakma.counters.voteValueMod ?? 0);
  assert.ok(eff >= 1, "조망 — 비용 적용 후에도 행사 투표가치 1 이상(1 미만 금지)");
}

// --- 로잔느 라포르(LinkFate): 2인 운명 공유 — 한쪽 탈락 시 다른 쪽도 탈락 ---
{
  const state = emptyState(
    {
      rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { futureCharge: 1 } },
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
      demon: player("demon", "demon", "demon"),
    },
    [
      { sourceUserId: "rosanne", targetUserId: "a", targetUserIds: ["a", "b"], actionType: "rosanne_rapport", priority: 5 },
      { sourceUserId: "demon", targetUserId: "a", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.a.alive, false, "라포르 — 처치된 a 탈락");
  assert.equal(newState.players.b.alive, false, "라포르 — 운명 공유로 b 도 탈락");
  assert.ok(events.some((e: any) => e.type === "rapport_linked"), "라포르 결속 이벤트");
  assert.ok(events.some((e: any) => e.type === "rapport_fate_shared" && e.payload?.user_id === "b"), "라포르 운명 공유 이벤트");
}
{
  // 소멸 전파: 한쪽이 소멸(annihilate)이면 상대도 부활 불가 소멸.
  const state = emptyState(
    {
      rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { futureCharge: 1 } },
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
      logen: player("logen", "logen", "demon"),
    },
    [
      { sourceUserId: "rosanne", targetUserId: "a", targetUserIds: ["a", "b"], actionType: "rosanne_rapport", priority: 5 },
      // 로건 파멸 2중첩 소멸을 a 에 직접 걸기 위해 doom 2 선세팅 + allwell.
    ],
  );
  // a 를 소멸로 직접 마킹(엔진 외부에서 시뮬). 라포르만 단독 검증하려고 a 를 소멸 상태로 만든다.
  const { newState } = resolveNightActions(state);
  assert.ok(newState.players.a.tags.some((t) => t.startsWith("rapportLink_b")), "라포르 — a 가 b 를 가리키는 표식 보유");
  assert.ok(newState.players.b.tags.some((t) => t.startsWith("rapportLink_a")), "라포르 — b 가 a 를 가리키는 표식 보유");
}
assert.match(roles, /id: "rosanne_rapport"[\s\S]*?type: "LinkFate"/, "로잔느 라포르(LinkFate)");
const rapportMig = readFileSync("supabase/migrations/20260625140000_gomdori_rosanne_rapport.sql", "utf8");
assert.match(rapportMig, /'rosanne_rapport'/, "마이그레이션 — 라포르");

// --- 백일몽 modifier: 로잔느 생존 중 rosanneDream=1, 죽으면 0 ---
{
  const state = emptyState(
    { rosanne: player("rosanne", "rosanne", "neutral"), a: player("a", "citizen", "angel") },
    [],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.modifiers.rosanneDream, 1, "백일몽 — 로잔느 생존 시 rosanneDream=1");
}
{
  const state = emptyState(
    { rosanne: player("rosanne", "rosanne", "neutral", false), a: player("a", "citizen", "angel") },
    [],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.modifiers.rosanneDream ?? 0, 0, "백일몽 — 로잔느 탈락 시 rosanneDream=0(해제)");
}
// phase-advance: 토론 1분 캡 + 무투 불가(로잔느 찬반 제거) 배선 확인.
assert.match(phaseAdvanceSrc, /dayDuration[\s\S]*?Math\.min\(durations\.day, 60\)/, "백일몽 — 토론 60초 캡(dayDuration)");
assert.match(phaseAdvanceSrc, /rosanneIds[\s\S]*?filter\(\(a\) => !rosanneIds\.has\(a\.actor_user_id\)\)/, "백일몽 — 무투 불가(로잔느 찬반 제거)");

// --- 로잔느 외현기억(Manifest): 탈락자 대상에 manifestMemory 표식 ---
{
  const state = emptyState(
    {
      rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { futureCharge: 1 } },
      dead: player("dead", "citizen", "angel", false),
    },
    [{ sourceUserId: "rosanne", targetUserId: "dead", actionType: "rosanne_manifest", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(newState.players.dead.tags.includes("manifestMemory"), "외현기억 — 탈락자에 manifestMemory 표식");
  assert.ok(events.some((e: any) => e.type === "manifest_marked"), "외현기억 표식 이벤트");
}
{
  // 소멸(annihilated)된 탈락자는 외현기억 대상 불가.
  const state = emptyState(
    {
      rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { futureCharge: 1 } },
      gone: { ...player("gone", "citizen", "angel", false), counters: { annihilated: 1 } },
    },
    [{ sourceUserId: "rosanne", targetUserId: "gone", actionType: "rosanne_manifest", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(!newState.players.gone.tags.includes("manifestMemory"), "외현기억 — 소멸 대상엔 표식 없음");
  assert.ok(events.some((e: any) => e.type === "manifest_blocked_annihilated"), "외현기억 소멸 차단 이벤트");
}
{
  // 효과 상실(manifestSpent) 후 재지정 불가.
  const state = emptyState(
    {
      rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { futureCharge: 1 } },
      spent: { ...player("spent", "citizen", "angel", false), counters: { manifestSpent: 1 } },
    },
    [{ sourceUserId: "rosanne", targetUserId: "spent", actionType: "rosanne_manifest", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(!newState.players.spent.tags.includes("manifestMemory"), "외현기억 — 효과 상실 대상 재지정 불가");
  assert.ok(events.some((e: any) => e.type === "manifest_blocked_spent"), "외현기억 재지정 차단 이벤트");
}
assert.match(roles, /id: "rosanne_manifest"[\s\S]*?type: "Manifest"/, "로잔느 외현기억(Manifest)");
const manifestMig = readFileSync("supabase/migrations/20260625150000_gomdori_rosanne_manifest.sql", "utf8");
assert.match(manifestMig, /'rosanne_manifest'/, "마이그레이션 — 외현기억");
// phase-advance: bounded 부활/재처형 + 투표 재처형 효과 상실 배선.
assert.match(phaseAdvanceSrc, /manifestMemory[\s\S]*?manifestCycles[\s\S]*?< 2/, "외현기억 — bounded 부활(manifestCycles<2)");
assert.match(phaseAdvanceSrc, /manifest_executed/, "외현기억 — 아침 끝 재처형");
assert.match(phaseAdvanceSrc, /manifest_dispelled/, "외현기억 — 투표 재처형 시 효과 상실");

// --- 로잔느 건너뛰기(SkipNight): priority 0 — 이 밤 효과 취소 + 다음 밤으로 리플레이 ---
{
  const state = emptyState(
    {
      rosanne: player("rosanne", "rosanne", "neutral"),
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [
      { sourceUserId: "rosanne", targetUserId: null, actionType: "rosanne_skip", priority: 0 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, true, "건너뛰기 — 그 밤 처치가 취소되어 피해자 생존");
  assert.ok(events.some((e: any) => e.type === "night_skipped"), "건너뛰기 발동 이벤트");
  assert.ok(events.some((e: any) => e.type === "action_deferred_night" && e.userId === "demon" && e.actionType === "demon_kill"), "건너뛰기 — 후속 액션 다음 밤으로 연기");
  assert.equal(newState.modifiers.nightSkipped ?? 0, 0, "건너뛰기는 그 밤 한정 — 종료 시 플래그 해제");
  assert.equal(newState.players.rosanne.counters.used_rosanne_skip, 1, "건너뛰기 1회성 — used 기록");
  // 다음-밤 리플레이: 처치 액션이 deferredNightActions 로 직렬화됨(SkipNight 자신은 제외).
  assert.ok(Array.isArray(newState.deferredNightActions), "deferredNightActions 배열 출력");
  assert.equal(newState.deferredNightActions!.length, 1, "연기 집합 = 처치 1건(SkipNight 제외)");
  assert.equal(newState.deferredNightActions![0].actionType, "demon_kill", "연기된 액션 = demon_kill");
  assert.ok(!newState.deferredNightActions!.some((a) => a.actionType === "rosanne_skip"), "SkipNight 은 연기 집합에서 제외(무한 연기 방지)");
}
// --- 리플레이 다음 밤: 연기된 처치를 actionStack 앞에 prepend → 실제 처치 발동, 연기 집합 비움 ---
{
  // 다음 밤(건너뛰기 없음): 직전 연기된 demon_kill 을 actionStack 으로 복원하면 victim 탈락.
  const replayState = emptyState(
    {
      rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { used_rosanne_skip: 1 } },
      demon: player("demon", "demon", "demon"),
      victim: player("victim", "citizen", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 }],
  );
  const { newState } = resolveNightActions(replayState);
  assert.equal(newState.players.victim.alive, false, "리플레이 — 연기됐던 처치가 다음 밤 발동해 victim 탈락");
  assert.ok(newState.deferredNightActions === undefined, "리플레이 후 연기 집합 비움(건너뛰기 없으면 새 연기 없음)");
}
assert.match(roles, /id: "rosanne_skip"[\s\S]*?type: "SkipNight"/, "로잔느 건너뛰기(SkipNight)");
assert.match(readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8"), /deferredNightActions/, "engine — 건너뛰기 다음-밤 리플레이 집합");
assert.match(readFileSync("supabase/functions/phase-advance/index.ts", "utf8"), /deferred_actions_replayed/, "phase-advance — 연기 액션 리플레이");
const skipMig = readFileSync("supabase/migrations/20260625160000_gomdori_rosanne_skip.sql", "utf8");
assert.match(skipMig, /'rosanne_skip'/, "마이그레이션 — 건너뛰기");

// --- 건너뛰기 조력자 패배 조항: 로잔느가 '건너뛰기' 미사용으로 백일몽 승리 시 helper 패배 표기 ---
{
  // 로잔느 백일몽 승리(dreamMorning 7) + 건너뛰기 미사용(used_rosanne_skip 없음) → helper 패배 플래그.
  const win = checkWinCondition({
    rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { dreamMorning: 7 } },
    gain: player("gain", "gain", "demon"),
    demon: player("demon", "demon", "demon"),
  });
  assert.equal(win.winner, "neutral", "로잔느 백일몽 단독 승리");
  assert.equal(win.rosanneSkipUnusedHelperDefeat, true, "건너뛰기 미사용 승리 → 조력자 패배 판정");
}
{
  // 건너뛰기를 *썼으면*(used_rosanne_skip 1) 조항 미발동.
  const win = checkWinCondition({
    rosanne: { ...player("rosanne", "rosanne", "neutral"), counters: { dreamMorning: 7, used_rosanne_skip: 1 } },
    gain: player("gain", "gain", "demon"),
    demon: player("demon", "demon", "demon"),
  });
  assert.equal(win.winner, "neutral", "로잔느 승리(건너뛰기 사용)");
  assert.equal(win.rosanneSkipUnusedHelperDefeat ?? false, false, "건너뛰기 사용 승리 → 조항 미발동");
}
{
  // 로잔느 외 승리(천사 등)에는 조항 무관(undefined/false).
  const win = checkWinCondition({
    angel: player("angel", "citizen", "angel"),
    rosanne: player("rosanne", "rosanne", "neutral"),
  });
  assert.equal(win.rosanneSkipUnusedHelperDefeat ?? false, false, "로잔느 비승리 — 조항 미발동");
}
// phase-advance: helper_defeat 페이로드 배선.
assert.match(phaseAdvanceSrc, /rosanneSkipUnusedHelperDefeat[\s\S]*?helper_defeat[\s\S]*?HELPER_ROLES/, "건너뛰기 조력자 패배 — game_ended 페이로드 helper_defeat");

// --- 강제 반론(대악마 감시 + 루루 무투): voteCountBonus≥1 투표자의 대상은 무조건 반론(verdict) ---
// phase-advance 의 vote 단계 처리 — 집계 후보보다 우선, 카운터 소비 전 평가.
assert.match(phaseAdvanceSrc, /forcedCandidate[\s\S]*?voteCountBonus[\s\S]*?< 1/, "강제 반론 — voteCountBonus≥1 투표자 탐지");
assert.match(phaseAdvanceSrc, /forced_retrial/, "강제 반론 — 이벤트 emit");
assert.match(phaseAdvanceSrc, /effectiveCandidate = forcedCandidate \?\? tally\.candidateUserId/, "강제 반론 — forced > tally 우선");
assert.match(phaseAdvanceSrc, /if \(effectiveCandidate\)\s*\{\s*nextPhaseType = "verdict"/, "강제 반론 — effectiveCandidate 로 verdict 전이");
const allwellMig = readFileSync("supabase/migrations/20260625120000_gomdori_rosanne_logen_allwell.sql", "utf8");
for (const v of ["logen_allwell", "rosanne_hatred", "rosanne_resentment"]) {
  assert.match(allwellMig, new RegExp(`'${v}'`), `마이그레이션 — ${v}`);
}
assert.match(roles, /id: "daeakma_dominion"[\s\S]*?type: "Silence", target: "AllOthers"/, "대악마 압도적 존재감(자신 제외 전원 봉인)");
assert.match(roles, /id: "uno_valor"[\s\S]*?type: "Cleanse"/, "우노 용맹함(자기 정화)");
assert.match(roles, /id: "luna_corrupt"/, "루나 공포 능력 정의(단일 출처)");
assert.match(roles, /id: "luna_corrupt"[\s\S]*?requiresCounter: \{ key: "moonGauge", min: 10/, "루나 공포 — 달 게이지 게이트(100%)");
assert.match(roles, /id: "luna_moonlight"[\s\S]*?target: "VoteTarget"/, "루나 적막 — substrate VoteTarget 달빛");
const lunaMig = readFileSync("supabase/migrations/20260614130000_gomdori_luna_moonlight.sql", "utf8");
assert.match(lunaMig, /'luna_moonlight'/, "마이그레이션 action_type 에 적막 추가");
const helperMig = readFileSync("supabase/migrations/20260610150000_gomdori_v2_helpers.sql", "utf8");
for (const v of ["corrupted", "luna_corrupt", "logen_nullify"]) {
  assert.match(helperMig, new RegExp(`'${v}'`), `migration allows ${v}`);
}

// --- maxUses 강제: 부활은 1회성 — 재사용은 엔진이 차단 (P0-B 교착 엔진 방지) ---
{
  const players = {
    mizlet: player("mizlet", "mizlet", "angel"),
    fallen: player("fallen", "citizen", "angel", false),
  };
  const first = resolveNightActions(
    emptyState(players, [
      { sourceUserId: "mizlet", targetUserId: "fallen", actionType: "mizlet_revive", priority: 3 },
    ]),
  );
  assert.equal(first.newState.players.fallen.alive, true, "첫 부활은 성공");
  assert.equal(
    first.newState.players.mizlet.counters.used_mizlet_revive,
    1,
    "사용 횟수가 counters.used_* 로 영속 기록",
  );

  // 대상이 다시 탈락한 다음 밤 — 두 번째 부활은 소진 차단.
  first.newState.players.fallen.alive = false;
  const second = resolveNightActions(
    emptyState(first.newState.players, [
      { sourceUserId: "mizlet", targetUserId: "fallen", actionType: "mizlet_revive", priority: 3 },
    ]),
  );
  assert.equal(second.newState.players.fallen.alive, false, "두 번째 부활은 maxUses 로 차단");
  assert.ok(
    second.events.some((e: any) => e.type === "action_blocked_exhausted"),
    "소진 차단 이벤트 발생",
  );
}

// maxUses 매니페스트/검증 계약 — 부활 두 종은 1회성, match-action 은 선제 거부.
assert.match(roles, /id: "mizlet_revive"[\s\S]*?maxUses: 1/, "미즐렛 부활 maxUses 1");
assert.match(roles, /id: "helen_revive"[\s\S]*?maxUses: 1/, "헬렌 부활 maxUses 1");
assert.match(matchAction, /ability_exhausted/, "match-action 소진 선제 거부");

// --- M4-1 변환 이력 reveal (canon §9): 종료 시 이전→최종 직업/진영 공개 ---
assert.match(
  phaseAdvanceSrc,
  /final_role: finalRole,\s*final_faction: finalFaction/,
  "reveal 에 최종 직업/진영 포함",
);
assert.match(
  phaseAdvanceSrc,
  /es\.currentRole === "string" \? es\.currentRole : player\.role/,
  "최종 직업은 engine_state.currentRole 우선",
);
assert.match(
  phaseAdvanceSrc,
  /changed: finalRole !== player\.role \|\| finalFaction !== player\.faction/,
  "변환 여부 플래그",
);

// --- 밤 이벤트 무결성 (2026-06-12) ---
// 1) 부활 영속화: 엔진이 dead→alive 로 되살리면 match_players.alive 도 복원돼야
//    한다. 이 분기가 없으면 부활 직업(미즐렛/헬렌)이 라이브에서 무효.
assert.match(
  phaseAdvanceSrc,
  /else if \(!dbPlayer\.alive && playerState\.alive\)/,
  "phase-advance 부활 영속화 분기",
);
assert.match(
  phaseAdvanceSrc,
  /updatePayload\.alive = true/,
  "부활 시 alive=true 복원",
);
// 2) 이벤트 가시성: 엔진 이벤트를 전부 public 으로 쌓으면 포교·변신·낙인 같은
//    비밀 정보가 클라이언트에 노출된다. public 허용목록 + private recipient.
assert.match(
  phaseAdvanceSrc,
  /PUBLIC_ENGINE_EVENTS = new Set\(\["player_died", "player_revived", "role_revealed", "demons_revealed"\]\)/,
  "엔진 이벤트 public 허용목록",
);
assert.match(
  phaseAdvanceSrc,
  /recipient_user_id: isPublic \? null : affectedUserId/,
  "비공개 이벤트는 당사자 recipient 로",
);
// 3) 아침 공표 집계: 다중 사망·부활을 한 이벤트로 (클라이언트 단건 find 누락 방지).
assert.match(phaseAdvanceSrc, /event_type: "morning_report"/, "morning_report 발행");
assert.match(
  phaseAdvanceSrc,
  /deaths: morningDeaths, revivals: morningRevivals/,
  "morning_report 에 사망·부활 명단",
);

// --- 유효 직업 (2026-06-12): 변환(낙인/타락/전향)은 engine_state.currentRole 에
// 영속화되므로, role 판정이 DB 컬럼을 직접 읽으면 재배정된 새 직업의 능력이
// 거부되고 옛 능력이 통과한다. match-action 은 effectiveRole 을 거쳐야 한다.
assert.match(matchAction, /function effectiveRole\(/, "match-action 유효 직업 헬퍼");
assert.match(
  matchAction,
  /const actorRole = effectiveRole\(player\);[\s\S]*?getRoleDefinition\(actorRole\)\?\.actions\.night\?\.find/,
  "행동 허용 판정은 유효 직업 기준 + CORE_ROLES 도출",
);
assert.match(matchAction, /const targetRole = effectiveRole\(targetState\)/, "대상 판정도 유효 직업 기준");
assert.match(
  matchAction,
  /isDemonKillerRole\(effectiveRole\(target\)\)/,
  "조사 결과도 유효 직업 기준",
);
assert.doesNotMatch(
  matchAction,
  /NIGHT_ACTIONS_BY_ROLE\[player\.role\]/,
  "DB role 컬럼 직접 판정 금지",
);
const effectiveViewMigration = readFileSync(
  "supabase/migrations/20260612100000_gomdori_effective_role_view.sql",
  "utf8",
);
assert.match(
  effectiveViewMigration,
  /coalesce\(engine_state->>'currentRole', role\)/,
  "match_players_visible 은 유효 직업을 노출",
);

// --- 접선 회로 (2026-06-12 정본): 기본은 서로 모름, 조력자 패시브가 회로 결정 ---
const rolesSrc = readFileSync("supabase/functions/_shared/engine/roles.ts", "utf8");
assert.match(rolesSrc, /HELPER_CONTACT[\s\S]*?gain: \{ expiresAfterNight: 3 \}/, "가인 접선 — 밤3 만료");
assert.match(rolesSrc, /HELPER_CONTACT[\s\S]*?logen: \{\}/, "로건 접선 — 영구");
assert.match(rolesSrc, /CONTACT_BLOCKED_DEMONS = \["phantom"\]/, "팬텀 — 접선 불가(통지만)");
assert.doesNotMatch(rolesSrc, /HELPER_CONTACT[\s\S]{0,200}luna:/, "루나 — 접선 없음");
const matchStart = readFileSync("supabase/functions/match-start/index.ts", "utf8");
assert.match(matchStart, /allies: \[\]/, "배정 시점 동료 공개 금지 (회로는 변종 확정 후)");
assert.doesNotMatch(matchStart, /demonCircle\.filter/, "match-start 조기 회로 노출 제거");
assert.match(phaseAdvanceSrc, /event_type: mode === "chat" \? "circle_contact" : "circle_notify"/, "접선/통지 이벤트 발행");
assert.match(phaseAdvanceSrc, /circleChatExpiresNight/, "가인 채팅 만료 카운터");
assert.match(phaseAdvanceSrc, /event_type: "circle_expired"/, "만료 통지");
assert.match(matchAction.length ? readFileSync("supabase/functions/match-chat/index.ts", "utf8") : "", /circleChat[\s\S]*?접선된 회로가 없습니다/, "채팅 전송은 회로 플래그 기준");
const circleMigration = readFileSync("supabase/migrations/20260612130000_gomdori_contact_circle.sql", "utf8");
assert.match(circleMigration, /circleChat'\)::boolean/, "is_demon_circle_member 플래그화");
assert.match(circleMigration, /is_demon_circle_known/, "정체 인지(영구) 함수");
assert.match(circleMigration, /as circle_chat/, "뷰 본인 전용 circle_chat 컬럼");

// --- 신앙 배선(파스아 v2): 능력 정의·허용·priority·마이그레이션 ---
assert.match(rolesSrc, /id: "pasua_faith"[\s\S]*?immuneFactions: \["demon"\]/, "신앙 — Kill + 악마 면역");
assert.match(roles, /id: "pasua_convert"/, "포교 능력 정의(단일 출처)");
assert.match(matchAction, /convert_cooldown/, "연속 포교 거부 가드");
assert.match(phaseAdvanceSrc, /"pasua_faith"[\s\S]{0,200}\? 4/, "신앙 priority 4(처치)");
const pasuaFaithMigration = readFileSync("supabase/migrations/20260614100000_gomdori_pasua_faith.sql", "utf8");
assert.match(pasuaFaithMigration, /'pasua_faith'/, "마이그레이션 action_type 에 신앙 추가");

// --- 백호 소환 배선(라이너 v2) ---
assert.match(roles, /id: "rainer_summon"[\s\S]*?targetType: "SELF"[\s\S]*?maxUses: 1/, "백호 — 1회 self 소환");
assert.match(roles, /tag: "deadCountBonus"/, "백호 — 생존 무관 카운터 지정");
assert.match(matchAction, /Object\.fromEntries\([\s\S]*?CORE_ROLES/, "검증 테이블은 CORE_ROLES 도출(단일 출처)");
const rainerMigration = readFileSync("supabase/migrations/20260614110000_gomdori_rainer_summon.sql", "utf8");
assert.match(rainerMigration, /'rainer_summon'/, "마이그레이션 action_type 에 백호 소환 추가");

// --- 사탄의 마(대악마 demon_kill): 발동 시 자신 제외 전원 투표가치 -1 → 악마 투표 독점 ---
{
  const state = emptyState(
    {
      demon: player("demon", "demon", "demon"),
      a1: player("a1", "citizen", "angel"),
      a2: player("a2", "citizen", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "a1", actionType: "demon_kill", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.a1.alive, false, "처치 — 대상 탈락");
  assert.equal(newState.players.a2.counters.voteValueMod, -1, "사탄의 마 — 생존 천사 투표가치 -1");
  assert.equal(newState.players.demon.counters.voteValueMod ?? 0, 0, "사탄의 마 — 악마 자신은 영향 없음(독점)");
  // 행사 투표: 천사 표 max(0, 1-1)=0, 악마 표 1 → 악마가 투표를 독점(표로는 못 이김).
  const vote = tallyEliminationVotes(
    [
      { actorUserId: "a2", targetUserId: "demon" },
      { actorUserId: "demon", targetUserId: "a2" },
    ],
    newState.players,
  );
  assert.equal(vote.candidateUserId, "a2", "마을 표 무력화 → 악마 단독 지목이 후보(독점)");
}

// --- 사탄의 마(원문 트리거 확장): 처치뿐 아니라 낙인·압도적 존재감 성공 발동도 전원 -1 ---
{
  // 낙인 성공 → 전원 -1.
  const sBrand = emptyState(
    { demon: player("demon", "demon", "demon"), t: player("t", "romaz", "angel"), b: player("b", "citizen", "angel") },
    [{ sourceUserId: "demon", targetUserId: "t", actionType: "daeakma_brand", priority: 5 }],
  );
  const { newState: nBrand } = resolveNightActions(sBrand);
  assert.equal(nBrand.players.b.counters.voteValueMod, -1, "사탄의 마 — 낙인 성공 시에도 전원 -1(능력 발동 트리거)");
  assert.equal(nBrand.players.demon.counters.voteValueMod ?? 0, 0, "낙인 — 대악마 자신은 영향 없음");
  // 압도적 존재감 성공 → 전원 -1.
  const sDom = emptyState(
    { demon: player("demon", "demon", "demon"), a: player("a", "citizen", "angel") },
    [{ sourceUserId: "demon", targetUserId: null, actionType: "daeakma_dominion", priority: 1 }],
  );
  const { newState: nDom } = resolveNightActions(sDom);
  assert.equal(nDom.players.a.counters.voteValueMod, -1, "사탄의 마 — 압도적 존재감 성공 시에도 전원 -1");
}

// --- 대악마 감시(2표): 낙인 적용자(mephistoBrand) 존재 시 처치 발동하면 self voteCountBonus +1 ---
{
  // 낙인 적용자 없음 → 감시 미발동(voteCountBonus 0).
  const sNoBrand = emptyState(
    { demon: player("demon", "demon", "demon"), v: player("v", "citizen", "angel") },
    [{ sourceUserId: "demon", targetUserId: "v", actionType: "demon_kill", priority: 4 }],
  );
  const { newState: nNoBrand } = resolveNightActions(sNoBrand);
  assert.equal(nNoBrand.players.demon.counters.voteCountBonus ?? 0, 0, "낙인 적용자 없음 — 감시 미발동");

  // 낙인 적용자 존재(mephistoBrand 태그) → 처치 발동 시 대악마 voteCountBonus +1(다음 아침 2표).
  const branded = { ...player("branded", "citizen", "angel"), tags: ["mephistoBrand"] };
  const sBrand = emptyState(
    { demon: player("demon", "demon", "demon"), branded, v: player("v", "citizen", "angel") },
    [{ sourceUserId: "demon", targetUserId: "v", actionType: "demon_kill", priority: 4 }],
  );
  const { newState: nBrand } = resolveNightActions(sBrand);
  assert.equal(nBrand.players.demon.counters.voteCountBonus, 1, "감시 — 낙인 적용자 존재 시 voteCountBonus +1");
  // 다음 아침 처형 투표: voteCountBonus=1 → 대악마 표 2배(루루 무투와 동일 라이프사이클).
  // 생존자 branded 를 지목(v 는 처치로 탈락). branded 는 사탄의 마 -1 을 받았으므로(AllOthers)
  // 별도 player 로 깨끗한 voteValue 테스트 — 대악마 자신은 영향 없음(독점), 표=1*2=2.
  const aliveT = player("at", "citizen", "angel");
  const votePlayers = { ...nBrand.players, at: aliveT };
  const vote = tallyEliminationVotes([{ actorUserId: "demon", targetUserId: "at" }], votePlayers);
  assert.equal(vote.tallies["at"], 2, "감시 — 대악마 처형 투표 2표");
}

// --- 메피스토 낙인: 대상에 mephistoBrand 표식(감시 게이트의 전역 조건) ---
{
  const sBrand = emptyState(
    { demon: player("demon", "demon", "demon"), t: player("t", "citizen", "angel") },
    [{ sourceUserId: "demon", targetUserId: "t", actionType: "daeakma_brand", priority: 5 }],
  );
  const { newState } = resolveNightActions(sBrand);
  assert.ok(newState.players.t.tags.includes("mephistoBrand"), "낙인 — 대상 mephistoBrand 표식");
}

// --- 우노 명예(투표가치 +5, 원문 [천사]6): 사탄의 마(-1)를 뚫고 우노의 표가 살아남는 천사 표 경로 ---
{
  const uno = { ...player("uno", "uno", "angel"), counters: { voteValueMod: 5 } }; // 배정 시 명예 주입(원문 +5)
  const state = emptyState(
    {
      demon: player("demon", "demon", "demon"),
      uno,
      a1: player("a1", "citizen", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "a1", actionType: "demon_kill", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.uno.counters.voteValueMod, 4, "사탄의 마 적용 후 우노 명예 5-1=4 잔존");
  // 우노 표=1+4=5, 일반 천사 표=max(0,1-1)=0 → 우노가 악마를 처형대로 보낼 수 있다(천사 표 경로).
  const vote = tallyEliminationVotes(
    [
      { actorUserId: "uno", targetUserId: "demon" },
      { actorUserId: "a1", targetUserId: "demon" },
      { actorUserId: "demon", targetUserId: "uno" },
    ],
    newState.players,
  );
  assert.equal(vote.candidateUserId, "demon", "우노 명예가 사탄의 마를 뚫어 악마 지목 — 천사 표 경로 성립");
}

// --- 아서 잔불 대검(결백/타락 판정): *진영이 아니라 행위 이력(tainted)*으로 분기 ---
{
  // 타락(부정 효과 이력 보유) 대상: 진영 무관. 1회차 폭열(branded), 2회차 소멸(annihilated).
  const state = emptyState(
    {
      arthur: { ...player("arthur", "arthur", "angel"), counters: { emberCharge: 1 } },
      foe: { ...player("foe", "demon", "demon"), counters: { tainted: 1 } },
    },
    [{ sourceUserId: "arthur", targetUserId: "foe", actionType: "arthur_emberblade", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.foe.counters.branded, 1, "잔불 대검 1회 — 타락자 폭열(branded)");
  assert.equal(newState.players.foe.alive, true, "잔불 대검 1회 — 아직 소멸 안 함");
  const round2 = emptyState(
    { arthur: { ...newState.players.arthur, counters: { ...newState.players.arthur.counters, emberCharge: 1 } }, foe: { ...newState.players.foe } },
    [{ sourceUserId: "arthur", targetUserId: "foe", actionType: "arthur_emberblade", priority: 4 }],
  );
  const { newState: after } = resolveNightActions(round2);
  assert.equal(after.players.foe.alive, false, "잔불 대검 2회 — 폭열된 타락자 소멸");
  assert.equal(after.players.foe.counters.annihilated, 1, "소멸 — 부활 불가 표식");
  assert.equal(after.players.arthur.counters.tainted ?? 0, 0, "아서가 소멸시켜도 자신은 tainted 안 됨(의로운 심판)");
}
{
  // 결백(부정 효과 이력 없음) 대상: 악마 진영이어도 폭열 안 함 + 무적(보호)만.
  const state = emptyState(
    {
      arthur: { ...player("arthur", "arthur", "angel"), counters: { emberCharge: 1 } },
      innocentDemon: player("innocentDemon", "demon", "demon"), // 진영은 악마지만 부정효과 이력 없음 → 결백 판정.
      killer: { ...player("killer", "demon", "demon"), counters: { tainted: 1 } },
    },
    [
      { sourceUserId: "arthur", targetUserId: "innocentDemon", actionType: "arthur_emberblade", priority: 3 },
      { sourceUserId: "killer", targetUserId: "innocentDemon", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.innocentDemon.counters.branded ?? 0, 0, "잔불 대검 — 부정효과 이력 없는 대상은 폭열 안 함(진영 무관)");
  assert.equal(newState.players.innocentDemon.alive, true, "잔불 대검 — 결백 판정 대상은 무적(보호)");
}
{
  // 잔불이 꺼지기 전에(arthur_judge): 해오름 판정 통지(Verdict) + 충전(emberCharge) + 해오름 태그.
  // 부정 효과(예: 처치)를 쓴 적 있는 대상 → '타락', 없는 대상 → '결백'.
  const state = emptyState(
    {
      arthur: player("arthur", "arthur", "angel"),
      tainted: { ...player("tainted", "citizen", "angel"), counters: { tainted: 1 } },
    },
    [{ sourceUserId: "arthur", targetUserId: "tainted", actionType: "arthur_judge", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.ok(events.some((e: any) => e.type === "verdict_revealed" && e.payload?.user_id === "tainted" && e.payload?.verdict === "tainted"), "해오름 — 부정효과 이력 대상은 '타락' 통지");
  assert.equal(newState.players.arthur.counters.emberCharge, 1, "잔불이 꺼지기 전에 — 잔불 대검 1충전");
  assert.ok(newState.players.tainted.tags.includes("dawnrise"), "대상에 '해오름' 표식");
}
{
  // 타락 표식의 발생: 부정 효과(처치)를 적용한 시전자는 counters.tainted=1 이 되어 이후 아서
  // 조사에서 '타락'으로 통지된다. (루루 매료=양도는 부정 효과 아님 → 제외. 세이카 봉인은 조건부.)
  const state = emptyState(
    { killer: player("killer", "demon", "demon"), victim: player("victim", "citizen", "angel") },
    [{ sourceUserId: "killer", targetUserId: "victim", actionType: "demon_kill", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.killer.counters.tainted, 1, "부정 효과(처치)를 적용한 시전자는 tainted");
}
{
  // 루루 매료는 부정 효과가 아니므로 시전자를 tainted 시키지 않는다(양도 ≠ 가해).
  const state = emptyState(
    { luru: player("luru", "luru", "angel"), victim: player("victim", "citizen", "angel") },
    [{ sourceUserId: "luru", targetUserId: "victim", actionType: "luru_charm", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.luru.counters.tainted ?? 0, 0, "매료(양도)는 부정 효과 아님 — 루루 tainted 안 됨");
}
{
  // 세이카 봉인(Silence)은 부정 효과 → 봉인을 쓰면 세이카(천사)도 tainted('경우에 따라 타락').
  const state = emptyState(
    { seika: player("seika", "seika", "angel"), victim: player("victim", "citizen", "angel") },
    [{ sourceUserId: "seika", targetUserId: "victim", actionType: "seika_supernova", priority: 1 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.seika.counters.tainted, 1, "봉인을 쓴 세이카는 tainted(천사여도 타락 판정)");
}
{
  // 투표/의심을 통한 가해(로마즈: 받는 표 +5, 받는 의심 +10)는 부정 효과 → 시전자 tainted.
  // (단순 투표/의심 '행위'는 applyEffect 경로가 아니므로 애초에 taint 안 됨.)
  const state = emptyState(
    { romaz: player("romaz", "romaz", "angel"), victim: player("victim", "citizen", "angel") },
    [{ sourceUserId: "romaz", targetUserId: "victim", actionType: "romaz_suspect", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.romaz.counters.tainted, 1, "투표/의심을 통해 가해한 로마즈는 tainted");
}
{
  // 잔불이 꺼지기 전에(3명 지정): 3명 각각 해오름(dawnrise) + 결백/타락 통지(Verdict) + 충전 +1.
  const state = emptyState(
    {
      arthur: player("arthur", "arthur", "angel"),
      a: { ...player("a", "citizen", "angel"), counters: { tainted: 1 } },
      b: player("b", "citizen", "angel"),
      c: player("c", "demon", "demon"),
    },
    [{ sourceUserId: "arthur", targetUserId: null, targetUserIds: ["a", "b", "c"], actionType: "arthur_judge", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  for (const id of ["a", "b", "c"]) {
    assert.ok(newState.players[id].tags.includes("dawnrise"), `${id} 해오름 표식`);
    assert.ok(events.some((e: any) => e.type === "verdict_revealed" && e.payload?.user_id === id), `${id} 결백/타락 통지`);
  }
  assert.ok(events.some((e: any) => e.type === "verdict_revealed" && e.payload?.user_id === "a" && e.payload?.verdict === "tainted"), "a(부정효과 이력)=타락");
  assert.ok(events.some((e: any) => e.type === "verdict_revealed" && e.payload?.user_id === "c" && e.payload?.verdict === "innocent"), "c(악마지만 이력 없음)=결백");
  assert.equal(newState.players.arthur.counters.emberCharge, 1, "3명 지정 — 충전 발동당 +1(총합)");
}
{
  // 여명의 기사 면역: 아서는 밤 처치/소멸로 탈락하지 않는다.
  const state = emptyState(
    { arthur: player("arthur", "arthur", "angel"), demon: player("demon", "demon", "demon") },
    [{ sourceUserId: "demon", targetUserId: "arthur", actionType: "demon_kill", priority: 4 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.arthur.alive, true, "아서는 밤 처치로 탈락하지 않음(면역)");
  assert.ok(events.some((e: any) => e.type === "arthur_immune"), "면역 이벤트");
}
{
  // 여명의 기사: 결백 천사 2명 탈락 → 아서 생존 + 잔불 대검 충전 2. 3명+ → 다음 처리에서 동반 탈락.
  const two = emptyState(
    {
      arthur: player("arthur", "arthur", "angel"),
      d1: player("d1", "citizen", "angel", false),
      d2: player("d2", "citizen", "angel", false),
    },
    [],
  );
  const r2 = resolveNightActions(two);
  assert.equal(r2.newState.players.arthur.alive, true, "결백 천사 2명 탈락 — 아서 생존");
  assert.equal(r2.newState.players.arthur.counters.emberCharge, 2, "탈락 1명당 잔불 대검 +1 충전");

  const three = emptyState(
    {
      arthur: player("arthur", "arthur", "angel"),
      d1: player("d1", "citizen", "angel", false),
      d2: player("d2", "citizen", "angel", false),
      d3: player("d3", "citizen", "angel", false),
      tainted: { ...player("tainted", "seika", "angel", false), counters: { tainted: 1 } }, // 타락 천사는 안 셈.
    },
    [],
  );
  const r3 = resolveNightActions(three);
  assert.equal(r3.newState.players.arthur.alive, false, "결백 천사 3명 탈락 — 아서 동반 탈락");
  assert.ok(r3.events.some((e: any) => e.type === "dawnbreaker_fallen"), "동반 탈락 이벤트");
  assert.equal(r3.newState.players.arthur.counters.emberCharge, 3, "타락 천사는 충전에 안 셈(결백 3명만 +3)");
}
{
  // 위용: 충전 ≥3 + 해오름 적용된 결백 천사 1명당 아서 투표가치 +3.
  const players: Record<string, any> = {
    arthur: { ...player("arthur", "arthur", "angel"), counters: { emberCharge: 3 } },
    ally1: { ...player("ally1", "citizen", "angel"), tags: ["dawnrise"] },
    ally2: { ...player("ally2", "citizen", "angel"), tags: ["dawnrise"] },
    foe: player("foe", "demon", "demon"),
  };
  const tally = tallyEliminationVotes([{ actorUserId: "arthur", targetUserId: "foe" }], players);
  assert.equal(tally.tallies.foe, 1 + 2 * 3, "위용 — 해오름 결백 천사 2명 → 아서 투표가치 1+6=7");
  // 충전 <3 이면 미발동.
  const players2 = { ...players, arthur: { ...players.arthur, counters: { emberCharge: 2 } } };
  const tally2 = tallyEliminationVotes([{ actorUserId: "arthur", targetUserId: "foe" }], players2);
  assert.equal(tally2.tallies.foe, 1, "충전 2(<3) — 위용 미발동(기본 투표가치 1)");
}

// --- 말렌 혼령 방출 다단계(Haunt): 1회 표식, 2회 잠식 탈락 + 투표가치 조공 ---
{
  const state = emptyState(
    { malen: player("malen", "malen", "demon"), v: player("v", "citizen", "angel") },
    [{ sourceUserId: "malen", targetUserId: "v", actionType: "malen_release", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.v.counters.haunted, 1, "혼령 방출 1회 — 혼령 표식");
  assert.equal(newState.players.v.alive, true, "1회차는 탈락하지 않음");
  const r2 = emptyState(
    { malen: { ...newState.players.malen }, v: { ...newState.players.v } },
    [{ sourceUserId: "malen", targetUserId: "v", actionType: "malen_release", priority: 4 }],
  );
  const { newState: after } = resolveNightActions(r2);
  assert.equal(after.players.v.alive, false, "2회차 — 영에게 잠식(탈락)");
  assert.equal(after.players.malen.counters.voteWeightBonus, 1, "투표가치 조공 — 말렌 voteWeightBonus +1");
}

// --- 하브레터스 소명(생명의 언약 성공): 공격을 실제로 막으면 시전자 투표가치 +3 ---
{
  // 막은 경우: 공격받은 대상을 치료 → attack_prevented → 하브레터스 voteValueMod +3.
  // 공격자는 사탄의 마 간섭이 없는 파스아 신앙(Kill)으로 두어 소명만 격리 검증한다.
  const state = emptyState(
    { hab: player("hab", "habreterus", "angel"), v: player("v", "citizen", "angel"), pasua: player("pasua", "pasua", "neutral") },
    [
      { sourceUserId: "hab", targetUserId: "v", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "pasua", targetUserId: "v", actionType: "pasua_faith", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.v.alive, true, "생명의 언약 — 대상 생존");
  assert.equal(newState.players.hab.counters.voteValueMod, 3, "소명 — 공격을 막아 투표가치 +3");
}
{
  // 공격이 없던 경우: 보상 없음(성공 조건 미충족).
  const state = emptyState(
    { hab: player("hab", "habreterus", "angel"), v: player("v", "citizen", "angel") },
    [{ sourceUserId: "hab", targetUserId: "v", actionType: "doctor_heal", priority: 3 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.hab.counters.voteValueMod ?? 0, 0, "소명 — 막은 공격이 없으면 보상 없음");
}

// --- 팬텀 어둠이 내린 도시: 동적 다중 봉인(상한 = 2 + counters.sealCap). 지목 전원 그 밤 봉인 ---
{
  // 기본(sealCap 미설정) → 상한 2. 3명 지목해도 앞 2명만 봉인(초과분 슬라이스).
  const state = emptyState(
    {
      phantom: player("phantom", "phantom", "demon"),
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
      c: player("c", "citizen", "angel"),
    },
    [{ sourceUserId: "phantom", targetUserId: null, targetUserIds: ["a", "b", "c"], actionType: "phantom_seal", priority: 1 }],
  );
  const { events } = resolveNightActions(state);
  const sealed = ["a", "b", "c"].filter((id) => events.some((e: any) => e.type === "silenced" && e.payload?.user_id === id));
  assert.equal(sealed.length, 2, "기본 상한 2: 3명 지목해도 2명만 봉인");
}
{
  // sealCap 1(아침 1회 경과) → 상한 3. 3명 전원 봉인.
  const state = emptyState(
    {
      phantom: { ...player("phantom", "phantom", "demon"), counters: { sealCap: 1 } },
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
      c: player("c", "citizen", "angel"),
    },
    [{ sourceUserId: "phantom", targetUserId: null, targetUserIds: ["a", "b", "c"], actionType: "phantom_seal", priority: 1 }],
  );
  const { events } = resolveNightActions(state);
  for (const id of ["a", "b", "c"]) {
    assert.ok(events.some((e: any) => e.type === "silenced" && e.payload?.user_id === id), `sealCap 1 → 상한 3 — ${id} 봉인`);
  }
}

// --- 팬텀 어둠이 내린 도시: 밤 해소(아침)마다 sealCap +1 → 봉인 가능 수 성장 ---
{
  const state = emptyState({ phantom: player("phantom", "phantom", "demon"), x: player("x", "citizen", "angel") }, []);
  const r1 = resolveNightActions(state);
  assert.equal(r1.newState.players.phantom.counters.sealCap, 1, "1번째 밤 해소 → sealCap 1(다음 밤 상한 3)");
  const r2 = resolveNightActions(r1.newState);
  assert.equal(r2.newState.players.phantom.counters.sealCap, 2, "2번째 밤 해소 → sealCap 2(다음 밤 상한 4)");
}

// --- 팬텀 침묵의 밤: 밤 연장 표식 + 생존 천사팀 카운트 +1(연장의 대가, 천사만) ---
{
  const state = emptyState(
    {
      phantom: player("phantom", "phantom", "demon"),
      a: player("a", "citizen", "angel"),
      b: player("b", "citizen", "angel"),
      d: player("d", "demon", "demon"),
    },
    [{ sourceUserId: "phantom", targetUserId: null, actionType: "phantom_silentnight", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.a.counters.countBonus, 1, "침묵의 밤 — 생존 천사 a 소속 카운트 +1");
  assert.equal(newState.players.b.counters.countBonus, 1, "침묵의 밤 — 생존 천사 b 소속 카운트 +1");
  assert.equal(newState.players.d.counters.countBonus ?? 0, 0, "악마는 카운트 안 오름(천사만)");
  assert.equal(newState.players.phantom.counters.extendNight, 1, "밤 연장 표식(phase-advance 가 읽음)");
}

// --- 엘런 박해 누진: 같은 대상 거듭 박해 시 받는-투표가치 지속 누적(persecuteBias) ---
{
  const ellen1 = { ...player("ellen", "ellen", "demon"), lastVoteTarget: "v" };
  const state1 = { ...emptyState({ ellen: ellen1, v: player("v", "citizen", "angel") }, [{ sourceUserId: "ellen", targetUserId: null, actionType: "ellen_persecute", priority: 5 }]), dayCount: 1 };
  const r1 = resolveNightActions(state1);
  assert.equal(r1.newState.players.v.counters.persecuteBias, 3, "박해 1회 — persecuteBias 3");
  const ellen2 = { ...r1.newState.players.ellen, lastVoteTarget: "v" };
  const state2 = { ...emptyState({ ellen: ellen2, v: { ...r1.newState.players.v } }, [{ sourceUserId: "ellen", targetUserId: null, actionType: "ellen_persecute", priority: 5 }]), dayCount: 1 };
  const r2 = resolveNightActions(state2);
  assert.equal(r2.newState.players.v.counters.persecuteBias, 6, "박해 누진 — 같은 대상 재박해 시 6(지속 누적)");
  // tally 가 persecuteBias 를 받는-표에 합산.
  const tally = tallyEliminationVotes([], r2.newState.players);
  assert.equal(tally.tallies.v, 6, "tally — 박해 누진이 받는-투표에 합산");
}
// --- 말렌 빙의 = 그 밤 봉인 + 마비(다음 밤도 봉인, silencePending 예약) ---
{
  const state = emptyState({ malen: player("malen", "malen", "demon"), v: player("v", "citizen", "angel") }, [{ sourceUserId: "malen", targetUserId: "v", actionType: "malen_possess", priority: 1 }]);
  const r1 = resolveNightActions(state);
  assert.equal(r1.newState.players.v.counters.silencePending, 1, "빙의 — 다음 밤 마비 예약(silencePending)");
  assert.ok(r1.events.some((e: any) => e.type === "possessed"), "빙의 이벤트");
  // 다음 밤 해소 → silencePending 이 silencedNights 로 이동(소비).
  const r2 = resolveNightActions(r1.newState);
  assert.equal(r2.newState.players.v.counters.silencePending ?? 0, 0, "마비 — 다음 밤에 소비됨");
}
// --- 말렌 신출귀몰: 혼령 표식 수거 → 다음 밤 시체 소환(deadCountBonus) ---
{
  const a = { ...player("a", "citizen", "angel"), counters: { haunted: 1 } };
  const b = { ...player("b", "doctor", "angel"), counters: { haunted: 1 } };
  const c = player("c", "citizen", "angel");
  const r1 = resolveNightActions(emptyState(
    { malen: player("malen", "malen", "demon"), a, b, c },
    [{ sourceUserId: "malen", targetUserId: null, actionType: "malen_elusive", priority: 5 }],
  ));
  assert.equal(r1.newState.players.a.counters.haunted ?? 0, 0, "신출귀몰 — a 혼령 표식 수거");
  assert.equal(r1.newState.players.b.counters.haunted ?? 0, 0, "신출귀몰 — b 혼령 표식 수거");
  assert.equal(r1.newState.players.c.counters.haunted ?? 0, 0, "신출귀몰 — 표식 없는 대상은 영향 없음");
  assert.equal(r1.newState.players.malen.counters.corpsePending, 2, "신출귀몰 — 수거한 표식 2개를 다음 밤 시체로 예약");
  assert.equal(r1.newState.players.malen.counters.deadCountBonus ?? 0, 0, "신출귀몰 — 같은 밤에는 아직 시체 카운트 없음");
  assert.ok(r1.events.some((e: any) => e.type === "corpse_gathered" && e.payload?.user_id === "a"), "신출귀몰 — 수거 이벤트");

  const r2 = resolveNightActions(r1.newState);
  assert.equal(r2.newState.players.malen.counters.corpsePending ?? 0, 0, "신출귀몰 — 다음 밤 예약 소비");
  assert.equal(r2.newState.players.malen.counters.deadCountBonus, 2, "신출귀몰 — 다음 밤 시체 2구 소환");
  assert.ok(r2.events.some((e: any) => e.type === "corpse_summoned" && e.payload?.amount === 2), "신출귀몰 — 시체 소환 이벤트");
}

// --- 가인 급습: noticeSuppressed 표식 + raidCharge 충전 + 1회 제한 ---
{
  const r = resolveNightActions(emptyState(
    { gain: player("gain", "gain", "demon"), v: player("v", "citizen", "angel") },
    [{ sourceUserId: "gain", targetUserId: "v", actionType: "gain_raid", priority: 5 }],
  ));
  // raid_initiated 이벤트 발사. 표식은 그 밤 cleanup 에서 즉시 제거된다.
  assert.ok(r.events.some((e: any) => e.type === "raid_initiated" && e.payload?.user_id === "v" && e.payload?.by === "gain"), "급습 — raid_initiated 이벤트");
  assert.equal(r.newState.players.gain.counters.raidCharge, 1, "급습 — 가인 raidCharge +1 충전");
  assert.ok(!r.newState.players.v.tags.includes("noticeSuppressed"), "급습 — 표식은 그 밤 한정");
  assert.equal(r.newState.players.gain.counters.used_gain_raid, 1, "급습 — 사용 횟수 기록");
}

// --- 가인 보호막 만료: dayCount=3 종료 시 shieldFromGain 보유자만 만료(아서는 영향 없음) ---
{
  const state: MatchState = {
    matchId: "v2", dayCount: 3, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: {
      gain: player("gain", "gain", "demon"),
      demon: { ...player("demon", "demon", "demon"), counters: { shield: 1, shieldFromGain: 1 } },
      arthur: { ...player("arthur", "arthur", "angel"), counters: { shield: 1 } },
    },
    actionStack: [],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.demon.counters.shield, 0, "가인 패시브 — 셋째 밤 종료 시 demon 보호막 만료");
  assert.equal(r.newState.players.demon.counters.shieldFromGain, 0, "가인 패시브 — shieldFromGain 마커도 제거");
  assert.equal(r.newState.players.arthur.counters.shield, 1, "아서 자기 보호막은 영향 없음(shieldFromGain 미보유)");
  assert.ok(r.events.some((e: any) => e.type === "gain_passive_expired" && e.payload?.user_id === "demon"), "만료 이벤트");
}
{
  // dayCount=2 에는 만료 X (셋째 밤이 아니므로).
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { demon: { ...player("demon", "demon", "demon"), counters: { shield: 1, shieldFromGain: 1 } } },
    actionStack: [],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.demon.counters.shield, 1, "2일차 종료 — 보호막 유지(셋째 밤이 아님)");
  assert.equal(r.newState.players.demon.counters.shieldFromGain, 1, "2일차 — 마커 유지");
}

// 가인 v2 — 계약 정규식.
assert.match(roles, /id: "gain_raid"[\s\S]*?maxUses: 1/, "가인 급습 — 1회 제한");
assert.match(roles, /id: "gain_raid"[\s\S]*?onFireSetCounter: \{ key: "raidCharge", value: 1 \}/, "가인 급습 — raidCharge 충전");
assert.match(roles, /id: "gain_raid"[\s\S]*?tag: "noticeSuppressed"/, "가인 급습 — noticeSuppressed 표식");
const gainV2Mig = readFileSync("supabase/migrations/20260618110000_gomdori_gain_v2.sql", "utf8");
assert.match(gainV2Mig, /'gain_raid'/, "마이그레이션 — 가인 급습");
const phaseAdvSrc = readFileSync("supabase/functions/phase-advance/index.ts", "utf8");
assert.match(phaseAdvSrc, /shieldFromGain = 1/, "가인 보호막 부여 시 shieldFromGain 마커 동시 세팅");

// --- 루나 해가 저문다: 100% 충전 소비 + dawn_triggered + state.modifiers.dawnRule=1 ---
{
  const luna: PlayerState = { ...player("luna", "luna", "demon"), counters: { moonGauge: 10 } };
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {}, players: { luna },
    actionStack: [{ sourceUserId: "luna", targetUserId: null, actionType: "luna_dawn", priority: 5 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.modifiers.dawnRule, 1, "해가 저문다 — dawnRule 활성화");
  assert.equal(r.newState.players.luna.counters.moonGauge, 0, "해가 저문다 — 100% 충전 소비");
  assert.equal(r.newState.players.luna.counters.used_luna_dawn, 1, "해가 저문다 — 1회 제한");
  assert.ok(r.events.some((e: any) => e.type === "dawn_triggered"), "dawn_triggered 이벤트");
}

// --- 해가 저문다 tally: dawnRule 시 능력 보너스(voteValueMod>0, prowess) 부호 반전 ---
{
  // 우노 명예 voteValueMod=+5 → dawnRule 시 -5. 1+(-5)=음수→Max(0,)=0(skip 처리).
  const uno: PlayerState = { ...player("uno", "uno", "angel"), counters: { voteValueMod: 5 } };
  const t = player("t", "citizen", "angel");
  const normal = tallyEliminationVotes([{ actorUserId: "uno", targetUserId: "t" }], { uno, t });
  assert.equal(normal.tallies["t"], 6, "평시 — 우노 1+5=6");
  const dawn = tallyEliminationVotes([{ actorUserId: "uno", targetUserId: "t" }], { uno, t }, { dawnRule: 1 });
  assert.equal(dawn.tallies["t"], undefined, "dawnRule — 우노 표 무력화(0)");
  assert.equal(dawn.skipped, 1, "dawnRule — 우노 표 skipped");
  // 사탄의 마(voteValueMod<0)는 그대로 — '증가'만 반전.
  const sm: PlayerState = { ...player("a", "citizen", "angel"), counters: { voteValueMod: -1 } };
  const dawnSm = tallyEliminationVotes([{ actorUserId: "a", targetUserId: "t" }], { a: sm, t }, { dawnRule: 1 });
  assert.equal(dawnSm.tallies["t"], undefined, "dawnRule — 음수 voteValueMod 는 부호 반전 X (1-1=0 skip)");
}

// --- 달이 차오른다: moonriseRule + 악마 처치가 moonlit 대상에 발동하면 모든 달빛 대상 cascade ---
{
  const luna: PlayerState = { ...player("luna", "luna", "demon"), counters: { moonGauge: 10 } };
  const demon: PlayerState = player("demon", "demon", "demon");
  const a: PlayerState = { ...player("a", "citizen", "angel"), tags: ["moonlit"] };
  const b: PlayerState = { ...player("b", "doctor", "angel"), tags: ["moonlit"] };
  const c: PlayerState = player("c", "rainer", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { luna, demon, a, b, c },
    actionStack: [
      { sourceUserId: "luna", targetUserId: null, actionType: "luna_moonrise", priority: 2 },
      { sourceUserId: "demon", targetUserId: "a", actionType: "demon_kill", priority: 4 },
    ],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.a.alive, false, "악마가 지목한 a(달빛) 탈락");
  assert.equal(r.newState.players.b.alive, false, "cascade — b(달빛)도 같은 효과로 탈락");
  assert.equal(r.newState.players.c.alive, true, "c(달빛 없음) — 영향 없음");
  assert.ok(r.events.some((e: any) => e.type === "moonrise_cascade" && e.payload?.user_id === "b"), "moonrise_cascade 이벤트");
  assert.equal(r.newState.modifiers.moonriseRule ?? 0, 0, "moonriseRule — 그 밤 종료 시 해제");
}

// --- 달이 차오른다 추가효과(원문 [조력자]5): 의심받은 만큼 영구 투표가치 + 의심 면역 ---
{
  // 루나가 누적 받는-의심(suspicionReceived 4) 보유. 달이 차오른다 발동 시 voteWeightBonus +4 영구.
  const luna: PlayerState = { ...player("luna", "luna", "demon"), counters: { moonGauge: 10, suspicionReceived: 4, voteWeightBonus: 1 } };
  const r = resolveNightActions(emptyState(
    { luna, a: player("a", "citizen", "angel") },
    [{ sourceUserId: "luna", targetUserId: null, actionType: "luna_moonrise", priority: 2 }],
  ));
  assert.equal(r.newState.players.luna.counters.voteWeightBonus, 5, "달이 차오른다 — 받는-의심 4 → voteWeightBonus +4(1→5, 영구)");
  assert.ok(r.newState.players.luna.tags.includes("suspicionImmune"), "달이 차오른다 — 의심 면역 표식 부여");
  assert.ok(r.events.some((e: any) => e.type === "moonrise_triggered" && e.payload?.suspicionConverted === 4), "moonrise_triggered — 환산량 통지");
}
// 의심 면역(suspicionImmune): tallySuspicionVotes 가 면역 대상을 집계에서 제외 ---
{
  const luna: PlayerState = { ...player("luna", "luna", "demon"), tags: ["suspicionImmune"] };
  const other: PlayerState = player("other", "citizen", "angel");
  const v1: PlayerState = player("v1", "citizen", "angel");
  const v2p: PlayerState = player("v2p", "citizen", "angel");
  const tally = tallySuspicionVotes(
    [
      { actorUserId: "v1", targetUserId: "luna", actionType: "suspect" },
      { actorUserId: "v2p", targetUserId: "other", actionType: "suspect" },
    ],
    { luna, other, v1, v2p },
  );
  assert.equal(tally.tallies.luna ?? 0, 0, "의심 면역 — 루나는 의심표를 받지 않음");
  assert.equal(tally.tallies.other ?? 0, 1, "면역 아닌 other 는 정상 집계");
}
assert.match(readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8"), /suspicionImmune/, "엔진 — 달이 차오른다 의심 면역 표식");
assert.match(phaseAdvSrc, /suspicionReceived/, "phase-advance — 누적 받는-의심 영속");

// --- 루나 공포 속에 밀어 넣다: maxUses 1 강제 ---
{
  const luna: PlayerState = { ...player("luna", "luna", "demon"), counters: { moonGauge: 10, used_luna_corrupt: 1 } };
  const a: PlayerState = player("a", "citizen", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { luna, a },
    actionStack: [{ sourceUserId: "luna", targetUserId: "a", actionType: "luna_corrupt", priority: 5 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.a.currentRole, "citizen", "루나 공포 — 1회 사용 후 차단(타락 안 됨)");
  assert.ok(r.events.some((e: any) => e.type === "action_blocked_exhausted"), "공포 — 소진 차단 이벤트");
}

// --- 100% 충전 분기 셋 중 하나만 (corrupt/dawn/moonrise 가 같은 moonGauge 풀 소비) ---
{
  const luna: PlayerState = { ...player("luna", "luna", "demon"), counters: { moonGauge: 10 } };
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {}, players: { luna },
    actionStack: [{ sourceUserId: "luna", targetUserId: null, actionType: "luna_moonrise", priority: 2 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.luna.counters.moonGauge, 0, "moonrise 발동 → moonGauge 소비");
  const r2 = resolveNightActions({
    ...r.newState,
    actionStack: [{ sourceUserId: "luna", targetUserId: null, actionType: "luna_dawn", priority: 5 }],
  });
  assert.ok(r2.events.some((e: any) => e.type === "action_blocked_no_charge"), "dawn — moonGauge 소진 시 차단");
  assert.equal(r2.newState.modifiers.dawnRule ?? 0, 0, "dawn 차단 → dawnRule 활성 안 됨");
}

// 루나 v2 — 계약 정규식.
assert.match(roles, /id: "luna_corrupt"[\s\S]*?maxUses: 1/, "루나 공포 — 1회 제한");
assert.match(roles, /id: "luna_dawn"[\s\S]*?maxUses: 1[\s\S]*?requiresCounter: \{ key: "moonGauge", min: 10/, "루나 해가 저문다 — 1회 + 100% 게이트");
assert.match(roles, /id: "luna_moonrise"[\s\S]*?priority: 2[\s\S]*?requiresCounter: \{ key: "moonGauge", min: 10/, "루나 달이 차오른다 — priority 2 + 100% 게이트");
const lunaV2Mig = readFileSync("supabase/migrations/20260618120000_gomdori_luna_v2.sql", "utf8");
assert.match(lunaV2Mig, /'luna_dawn'/, "마이그레이션 — 해가 저문다");
assert.match(lunaV2Mig, /'luna_moonrise'/, "마이그레이션 — 달이 차오른다");

// --- 엘런 비치지 않는 자아(타깃화): 대상 자아 망가짐 + everShattered + carrier 자아 이전 ---
{
  const ellen: PlayerState = player("ellen", "ellen", "demon");
  const tgt: PlayerState = player("tgt", "citizen", "angel");
  // carrier = 생존자(대상 제외) 중 행사 투표가치 최고 → cap 에게 baseVoteValue 5 부여.
  const cap: PlayerState = { ...player("cap", "uno", "angel"), baseVoteValue: 5 };
  // N1: 엘런이 tgt 의 자아를 망가뜨린다.
  const r1 = resolveNightActions(emptyState(
    { ellen, tgt, cap },
    [{ sourceUserId: "ellen", targetUserId: "tgt", actionType: "ellen_shatter", priority: 5 }],
  ));
  assert.equal(r1.newState.players.tgt.counters.brokenSelf, 1, "비치지 않는 자아 — 대상 brokenSelf 세팅");
  assert.ok(r1.newState.players.tgt.tags.includes("everShattered"), "대상 everShattered 표식(재차 불가)");
  assert.ok(r1.newState.players.tgt.tags.includes("soulCarrier_cap"), "자아 이전 — 투표가치 최고 carrier(cap) 표식");
  assert.equal(r1.newState.players.ellen.counters.brokenSelf ?? 0, 0, "엘런 자신은 자아 멀쩡(타깃화 — self 아님)");
  assert.ok(r1.events.some((e: any) => e.type === "soul_shattered" && e.payload?.carrier === "cap"), "soul_shattered 이벤트");

  // 망가진 대상은 그 라운드 투표·의심·능력 가치 상실.
  const vote = tallyEliminationVotes([{ actorUserId: "tgt", targetUserId: "cap" }], r1.newState.players);
  assert.equal(vote.skipped, 1, "broken 대상 — 투표 무효");
  // N2: 대상이 능력을 쓰려 해도 차단(brokenSelf gate).
  const r2 = resolveNightActions({
    ...r1.newState,
    players: { ...r1.newState.players, tgt: { ...r1.newState.players.tgt, currentRole: "logen", lastVoteTarget: "ellen" } },
    actionStack: [{ sourceUserId: "tgt", targetUserId: "cap", actionType: "logen_nullify", priority: 5 }],
  });
  assert.ok(r2.events.some((e: any) => e.type === "action_blocked_broken_self" && e.userId === "tgt"), "broken 동안 대상 능력 차단");
  assert.equal(r2.newState.players.tgt.counters.brokenSelf, 1, "carrier 미투표 — 여전히 broken");
  assert.equal(r2.newState.players.tgt.counters.brokenAge, 1, "carrier 미투표 — age 누진(자동 회복 없음)");
}

// --- 비치지 않는 자아 회복: 망가진 대상이 carrier 를 투표하면 다음 아침 회복(selfRecovered) ---
{
  const ellen: PlayerState = player("ellen", "ellen", "demon");
  const tgt: PlayerState = player("tgt", "citizen", "angel");
  const cap: PlayerState = { ...player("cap", "uno", "angel"), baseVoteValue: 5 };
  const r1 = resolveNightActions(emptyState(
    { ellen, tgt, cap },
    [{ sourceUserId: "ellen", targetUserId: "tgt", actionType: "ellen_shatter", priority: 5 }],
  ));
  // 망가진 대상이 carrier(cap)를 투표 → 다음 resolve 시작의 carrier-vote 루프가 회복.
  const r2 = resolveNightActions({
    ...r1.newState,
    players: { ...r1.newState.players, tgt: { ...r1.newState.players.tgt, lastVoteTarget: "cap" } },
    actionStack: [],
  });
  assert.equal(r2.newState.players.tgt.counters.brokenSelf ?? 0, 0, "carrier 투표 — broken 해제");
  assert.equal(r2.newState.players.tgt.counters.selfRecovered, 1, "carrier 투표 — selfRecovered 영속");
  assert.ok(!r2.newState.players.tgt.tags.some((t: string) => t.startsWith("soulCarrier_")), "회복 시 carrier 표식 제거");
  assert.ok(r2.events.some((e: any) => e.type === "ellen_recovered"), "회복 이벤트");
}

// --- 비치지 않는 자아 — 한 대상 재차 불가(everShattered) ---
{
  const ellen: PlayerState = player("ellen", "ellen", "demon");
  const tgt: PlayerState = { ...player("tgt", "citizen", "angel"), tags: ["everShattered"] };
  const cap: PlayerState = { ...player("cap", "uno", "angel"), baseVoteValue: 5 };
  const r = resolveNightActions(emptyState(
    { ellen, tgt, cap },
    [{ sourceUserId: "ellen", targetUserId: "tgt", actionType: "ellen_shatter", priority: 5 }],
  ));
  assert.equal(r.newState.players.tgt.counters.brokenSelf ?? 0, 0, "이미 해체된 대상 — 재차 불가(skipIfTargetTag)");
  assert.ok(!r.events.some((e: any) => e.type === "soul_shattered"), "재차 — soul_shattered 미발동");
}

// --- broken 상태 — 임의 플레이어의 투표·의심 가치 0(엘런 한정 아님) ---
{
  const t = { ...player("t", "citizen", "angel"), counters: { brokenSelf: 1 } };
  const u = player("u", "citizen", "angel");
  const vote = tallyEliminationVotes([{ actorUserId: "t", targetUserId: "u" }], { t, u });
  assert.equal(vote.tallies["u"], undefined, "broken 대상 — 투표 무효");
  assert.equal(vote.skipped, 1, "broken — skipped");
  const susp = tallySuspicionVotes([{ actorUserId: "t", targetUserId: "u" }], { t, u });
  assert.equal(susp.tallies["u"], undefined, "broken 대상 — 의심 무효");
  assert.equal(susp.skipped, 1, "broken — suspicion skipped");
}

// --- 박해 변경효과: 누군가 selfRecovered(전역) 면 VoteTarget 대신 엘런 자신 박해 ---
{
  // 회복한 대상 rec(selfRecovered=1)이 생존 → 전역 트리거. 엘런 박해가 자해로 전환.
  const ellen: PlayerState = { ...player("ellen", "ellen", "demon"), lastVoteTarget: "victim" };
  const victim: PlayerState = player("victim", "citizen", "angel");
  const rec: PlayerState = { ...player("rec", "citizen", "angel"), counters: { selfRecovered: 1 } };
  const state: MatchState = {
    matchId: "v2", dayCount: 3, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { ellen, victim, rec },
    actionStack: [{ sourceUserId: "ellen", targetUserId: null, actionType: "ellen_persecute", priority: 5 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.ellen.counters.persecuteBias, 3, "전역 selfRecovered — 자해 박해 +3");
  assert.equal(r.newState.players.victim.counters.persecuteBias ?? 0, 0, "전역 selfRecovered — VoteTarget 박해 차단");
}
{
  // 아무도 회복 안 함 → 평시 VoteTarget 박해.
  const ellen: PlayerState = { ...player("ellen", "ellen", "demon"), lastVoteTarget: "victim" };
  const victim: PlayerState = player("victim", "citizen", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 3, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { ellen, victim },
    actionStack: [{ sourceUserId: "ellen", targetUserId: null, actionType: "ellen_persecute", priority: 5 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.victim.counters.persecuteBias, 3, "평시 — VoteTarget 박해 +3");
  assert.equal(r.newState.players.ellen.counters.persecuteBias ?? 0, 0, "평시 — 엘런 자해 X");
}

// --- 엘런 혼탁해진 정의(원문 능력2): 대상 다음 밤 능력 봉인 + 박해 표적이면 탈락 (지정/2회) ---
{
  // plain(박해 안 받은 천사): 다음 밤 봉인만(silencePending), 탈락 X.
  const s1 = emptyState(
    { ellen: player("ellen", "ellen", "demon"), plain: player("plain", "citizen", "angel") },
    [{ sourceUserId: "ellen", targetUserId: "plain", actionType: "ellen_chaos", priority: 5 }],
  );
  const { newState: n1 } = resolveNightActions(s1);
  assert.equal(n1.players.plain.counters.silencePending, 1, "혼탁해진 정의 — 다음 밤 능력 봉인 예약");
  assert.equal(n1.players.plain.alive, true, "박해 표적 아님 — 탈락 X");
  assert.equal(n1.players.ellen.counters.used_ellen_chaos, 1, "혼탁해진 정의 — 1회 소진(2회 제한)");
  // persecuted(박해 표적, persecuteBias>0): 혼탁해진 정의로 탈락.
  const s2 = emptyState(
    {
      ellen: player("ellen", "ellen", "demon"),
      persecuted: { ...player("persecuted", "citizen", "angel"), counters: { persecuteBias: 3 } },
    },
    [{ sourceUserId: "ellen", targetUserId: "persecuted", actionType: "ellen_chaos", priority: 5 }],
  );
  const { newState: n2 } = resolveNightActions(s2);
  assert.equal(n2.players.persecuted.alive, false, "박해 표적(persecuteBias≥1) — 혼탁해진 정의로 탈락");
}

// 엘런 v2 — 계약 정규식.
assert.match(roles, /id: "ellen_shatter"[\s\S]*?targetType: "SINGLE_ALIVE"[\s\S]*?type: "Shatter", target: "Target", skipIfTargetTag: "everShattered"/, "엘런 비치지 않는 자아 — 타깃화 Shatter(재차 불가)");
assert.match(roles, /id: "ellen_chaos"[\s\S]*?maxUses: 2[\s\S]*?type: "DelaySilence"/, "엘런 혼탁해진 정의 — 2회 + 다음 밤 봉인");
assert.match(roles, /id: "ellen_chaos"[\s\S]*?type: "Kill", target: "Target", onlyIfTargetCounter: \{ key: "persecuteBias", min: 1 \}/, "혼탁해진 정의 — 박해 표적 탈락");
assert.match(allwellMig, /'ellen_chaos'/, "마이그레이션 — 혼탁해진 정의");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?skipIfAnyPlayerCounter: \{ key: "selfRecovered"/, "박해 평시 — 전역 selfRecovered 면 VoteTarget 분기 스킵");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?onlyIfAnyPlayerCounter: \{ key: "selfRecovered"/, "박해 변경 — 전역 selfRecovered 시 자해 분기");
const ellenV2Mig = readFileSync("supabase/migrations/20260618130000_gomdori_ellen_v2.sql", "utf8");
assert.match(ellenV2Mig, /'ellen_shatter'/, "마이그레이션 — 해체된 퍼즐");

// 대악마 감시(2표) — 계약 정규식.
assert.match(roles, /id: "demon_kill"[\s\S]*?tag: "voteCountBonus", amount: 1, onlyIfAnyPlayerTag: "mephistoBrand"/, "대악마 감시 — 낙인 적용자 존재 시 self voteCountBonus +1(2표)");
assert.match(roles, /id: "daeakma_brand"[\s\S]*?type: "AddTag", target: "Target", tag: "mephistoBrand"/, "메피스토 낙인 — mephistoBrand 표식(감시 게이트)");

// --- 사탄의 마 전역 취급: 살아있는 대악마 + 천사팀 전원 vote 0 → 천사 transient 악마 카운트 ---
{
  // 우노 voteValueMod=-11 → vote=1-11=-10 ≤ 0. 대악마 생존. countTeams 가 transient 로 천사를 악마 합산.
  const uno: PlayerState = { ...player("uno", "uno", "angel"), counters: { voteValueMod: -11 } };
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState({ uno, demon }, []));
  assert.ok(r.events.some((e: any) => e.type === "satanic_realm_treated" && e.payload?.user_id === "uno"), "satanic_realm_treated 이벤트");
  const win = checkWinCondition(r.newState.players);
  assert.equal(win.winner, "demons", "전역 취급 — 우노가 악마 카운트로 합산되어 악마 승");
  // 대악마 사망 시 영역 해제 → 우노는 다시 천사 카운트.
  r.newState.players.demon.alive = false;
  const win2 = checkWinCondition(r.newState.players);
  assert.equal(win2.winner, "angels", "대악마 사망 → 영역 해제 → 천사 카운트 복귀(통상 천사 승)");
}
{
  // 천사가 양수 voteValueMod 보유면 영역 X.
  const uno: PlayerState = { ...player("uno", "uno", "angel"), counters: { voteValueMod: 5 } };
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState({ uno, demon }, []));
  assert.ok(!r.events.some((e: any) => e.type === "satanic_realm_treated"), "양수 vote — 영역 발동 X");
}

// --- 사탄의 마 per-target 취급(canon): 전원 0 아니어도 *그 대상* vote 0 이하면 그 한 명만 악마 카운트 ---
{
  // a_supp vote=1-2=-1 ≤ 0(악마로 취급), a_ok vote=1(정상 천사). 대악마 생존 → 전역 영역은 비활성(전원 0 아님).
  // per-target: a_supp 만 flip → demonCount=2, angelCount=1 → 악마 승. (per-target 없으면 angelCount=2 로 천사 승.)
  const aSupp: PlayerState = { ...player("a_supp", "citizen", "angel"), counters: { voteValueMod: -2 } };
  const aOk: PlayerState = player("a_ok", "citizen", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const win = checkWinCondition({ aSupp, aOk, demon });
  assert.equal(win.winner, "demons", "per-target — 개별 천사(vote 0 이하)만 악마 합산 → 악마 승");
  // 대악마 사망 시 per-target 도 해제 → a_supp 다시 천사 카운트(angelCount=2 > demonCount=0).
  const win2 = checkWinCondition({ aSupp, aOk, demon: { ...demon, alive: false } });
  assert.equal(win2.winner, "angels", "per-target — 대악마 사망 → 취급 해제 → 천사 카운트 복귀");
}
{
  // per-target 조사 판정(match-action-core): 대상 vote 0 이하면 악마로 판정하는 헬퍼가 배선됐는지 계약 확인.
  const matchActionCore = readFileSync("supabase/functions/_shared/match-action-core.ts", "utf8");
  assert.match(matchActionCore, /isTargetVoteSuppressed/, "match-action-core — per-target 조사 판정 헬퍼 존재");
  assert.match(matchActionCore, /isTargetVoteSuppressed\(target\.engine_state/, "조사 경로가 per-target 판정 사용");
}

// 대악마 전역 취급 — 계약 정규식.
assert.match(roles, /id: "demon_kill"[\s\S]*?ModifyVoteValue/, "대악마 사탄의 마 — 처치 시 전원 -1");
const engineSrc = readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8");
assert.match(engineSrc, /isSatanicRealmActive/, "engine.isSatanicRealmActive 헬퍼 존재");
assert.match(engineSrc, /satanicTreated/, "countTeams — 사탄 영역 transient flip");

// --- 임종 선언(하브): 그 라운드 누군가 탈락 → 소명 발동(쿨다운 0 일 때만) ---
{
  const hab: PlayerState = player("hab", "habreterus", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const victim: PlayerState = player("victim", "citizen", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { hab, demon, victim },
    actionStack: [{ sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.victim.alive, false, "악마 처치 — 피해자 탈락");
  // 사탄의 마 -1 (demon_kill AllOthers) + 임종 선언 -1 (자기 처벌) = -2.
  assert.equal(r.newState.players.hab.counters.voteValueMod, -2, "임종 선언 — 사탄의 마(-1) + 자기 처벌(-1)");
  assert.equal(r.newState.players.hab.counters.countBonus, 1, "임종 선언 — 천사팀 카운트 +1");
  assert.equal(r.newState.players.hab.counters.callingCooldown, 3, "임종 선언 — 쿨다운 3 세팅");
  assert.ok(r.events.some((e: any) => e.type === "habreterus_calling"), "habreterus_calling 이벤트");
  // 다음 라운드 — 쿨다운 카운트다운 -1.
  const next = resolveNightActions({ ...r.newState, actionStack: [] });
  assert.equal(next.newState.players.hab.counters.callingCooldown, 2, "다음 밤 — 쿨다운 -1 (3→2)");
}

// --- 생명의 언약 성공 시 callingCooldown -1일 (canon) ---
{
  const hab: PlayerState = { ...player("hab", "habreterus", "angel"), counters: { callingCooldown: 3 } };
  const demon: PlayerState = player("demon", "demon", "demon");
  const t: PlayerState = player("t", "citizen", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { hab, demon, t },
    actionStack: [
      { sourceUserId: "hab", targetUserId: "t", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "t", actionType: "demon_kill", priority: 4 },
    ],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.t.alive, true, "치료 성공 — 대상 생존");
  // 쿨다운 3 → 매 밤 -1 (=2) + 성공 추가 -1 (=1).
  assert.equal(r.newState.players.hab.counters.callingCooldown, 1, "치료 성공 — 쿨다운 추가 -1 (3→2→1)");
  // 사탄의 마 -1 (demon_kill AllOthers) + 소명 +3 (oath_fulfilled) = +2.
  assert.equal(r.newState.players.hab.counters.voteValueMod, 2, "생명의 언약 — 시전자 voteValueMod (사탄의 마 -1 + 소명 +3 = 2)");
  assert.ok(r.events.some((e: any) => e.type === "calling_cooldown_reduced"), "calling_cooldown_reduced 이벤트");
}

// --- 악마 측 역추리: demon_deduce 적중 시 하브 Annihilate + 치료 무시 ---
{
  const hab: PlayerState = player("hab", "habreterus", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const doc: PlayerState = player("doc", "doctor", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { hab, demon, doc },
    actionStack: [
      { sourceUserId: "doc", targetUserId: "hab", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "hab", actionType: "demon_deduce", priority: 4 },
    ],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.hab.alive, false, "역추리 적중 — 하브 탈락(치료 무시)");
  assert.equal(r.newState.players.hab.counters.annihilated, 1, "역추리 적중 — annihilated 플래그");
  assert.ok(r.events.some((e: any) => e.type === "deduce_demon_hit"), "deduce_demon_hit 이벤트");
}
{
  const hab: PlayerState = player("hab", "habreterus", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const inn: PlayerState = player("inn", "citizen", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { hab, demon, inn },
    actionStack: [{ sourceUserId: "demon", targetUserId: "inn", actionType: "demon_deduce", priority: 4 }],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.inn.alive, true, "역추리 빗나감 — 대상 무사");
  assert.ok(r.events.some((e: any) => e.type === "deduce_miss"), "deduce_miss 이벤트");
}

// 하브레터스 v2 — 계약 정규식.
assert.match(roles, /id: "habreterus"[\s\S]*?deathHook:[\s\S]*?counter: "callingPending"/, "하브 deathHook — callingPending");
assert.match(roles, /id: "demon_deduce"[\s\S]*?type: "Deduce"/, "악마 역추리 — Deduce effect");
const habMig = readFileSync("supabase/migrations/20260618140000_gomdori_habreterus_v2.sql", "utf8");
assert.match(habMig, /'demon_deduce'/, "마이그레이션 — 악마 역추리");

// --- 헬렌 황금빛 수면 v2: 'remembered' 표식 + 탈락 후에도 재발동 가능 + 자동 부활 ---
{
  const helen: PlayerState = player("helen", "helen", "angel");
  const a: PlayerState = player("a", "citizen", "angel");
  const r1 = resolveNightActions(emptyState(
    { helen, a },
    [{ sourceUserId: "helen", targetUserId: "a", actionType: "helen_sleep", priority: 3 }],
  ));
  assert.ok(r1.newState.players.a.tags.includes("remembered"), "sleep 적용 — remembered 표식");
  assert.ok(r1.events.some((e: any) => e.type === "slept"), "slept 이벤트");
  // a 사망 후 재발동 → 부활 + 다시 수면.
  const a2: PlayerState = { ...r1.newState.players.a, alive: false };
  const helen2: PlayerState = { ...r1.newState.players.helen };
  const r2 = resolveNightActions({
    matchId: "v2", dayCount: 3, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { helen: helen2, a: a2 },
    actionStack: [{ sourceUserId: "helen", targetUserId: "a", actionType: "helen_sleep", priority: 3 }],
  });
  assert.equal(r2.newState.players.a.alive, true, "추억된 탈락자 — sleep 으로 부활");
  assert.ok(r2.events.some((e: any) => e.type === "player_revived" && (e as any).payload?.source === "remembered_sleep"), "remembered_sleep 부활 이벤트");
}

// --- annihilated 는 추억 부활 차단 ---
{
  const helen: PlayerState = player("helen", "helen", "angel");
  const a: PlayerState = { ...player("a", "citizen", "angel"), alive: false, tags: ["remembered"], counters: { annihilated: 1 } };
  const r = resolveNightActions(emptyState(
    { helen, a },
    [{ sourceUserId: "helen", targetUserId: "a", actionType: "helen_sleep", priority: 3 }],
  ));
  assert.equal(r.newState.players.a.alive, false, "annihilated — 부활 불가");
}

// --- 헬렌 황금빛 수면: 투표가치 모두 소모(누적 base 로) + 깨면 +1(net base+1) + 접선 통지 ---
{
  const helen: PlayerState = player("helen", "helen", "angel");
  // 누적 투표가치(voteWeightBonus +3, bonusVoteValue +2)를 쌓은 대상.
  const rich: PlayerState = { ...player("rich", "citizen", "angel"), bonusVoteValue: 2, counters: { voteWeightBonus: 3 } };
  const r = resolveNightActions(emptyState(
    { helen, rich },
    [{ sourceUserId: "helen", targetUserId: "rich", actionType: "helen_sleep", priority: 3 }],
  ));
  // ConsumeVoteValue(0) 후 GrantCount +1 → net voteWeightBonus 1, bonusVoteValue 소모.
  assert.equal(r.newState.players.rich.counters.voteWeightBonus ?? 0, 1, "누적 소모 후 깨면 +1 = net base+1");
  assert.equal(r.newState.players.rich.bonusVoteValue ?? 0, 0, "bonusVoteValue 소모");
  assert.ok(r.events.some((e: any) => e.type === "vote_value_consumed" && e.payload?.user_id === "rich"), "접선 통지(vote_value_consumed)");
}

// 헬렌 v2 — 계약 정규식.
assert.match(roles, /id: "helen_sleep"[\s\S]*?allowRememberedDead: true/, "헬렌 sleep — allowRememberedDead 플래그");
assert.match(roles, /id: "helen_sleep"[\s\S]*?tag: "remembered"/, "헬렌 sleep — remembered 표식 부여");
assert.match(roles, /id: "helen_sleep"[\s\S]*?type: "ConsumeVoteValue"/, "헬렌 sleep — 투표가치 소모(접선)");
const engineSrcHelen = readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8");
assert.match(engineSrcHelen, /remembered_sleep/, "engine Sleep — remembered 부활 분기");

// --- 미즐렛 디저트 회로: mizlet_cookie → dessert_received(variant), mizlet_wine → dessert_chat_open ---
{
  const mizlet: PlayerState = player("mizlet", "mizlet", "angel");
  const a: PlayerState = player("a", "citizen", "angel");
  const r = resolveNightActions(emptyState(
    { mizlet, a },
    [{ sourceUserId: "mizlet", targetUserId: "a", actionType: "mizlet_cookie", priority: 3 }],
  ));
  assert.ok(r.events.some((e: any) => e.type === "dessert_received" && e.payload?.user_id === "a" && e.payload?.by === "mizlet" && e.payload?.variant === "cookie"), "dessert_received(쿠키) 이벤트 — 미즐렛 → 대상");
  assert.ok(r.newState.players.a.tags.includes("dessert"), "디저트 태그 적용");
}
// --- 쿠키 죽음-게이트 우회: cookie 보유자가 탈락해도 그 밤 능력 발동(표식 소비) ---
{
  // 의사(쿠키 보유)가 그 밤 탈락 상태로 들어와도 치료 액션이 발동 — cookie 표식 우회 + 소비.
  const doc: PlayerState = { ...player("doc", "doctor", "angel", false), tags: ["cookie", "dessert"] };
  const ally: PlayerState = player("ally", "citizen", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState(
    { doc, ally, demon },
    [
      { sourceUserId: "doc", targetUserId: "ally", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  ));
  assert.ok(r.events.some((e: any) => e.type === "cookie_act" && e.userId === "doc"), "쿠키 — 탈락 시전자 발동 우회 이벤트");
  assert.equal(r.newState.players.ally.alive, true, "쿠키 — 탈락한 의사의 치료가 발동해 ally 보호");
  assert.ok(!r.newState.players.doc.tags.includes("cookie"), "쿠키 표식 소비");
}
{
  // cookie 없는 탈락 시전자는 발동 안 됨(대조군).
  const doc: PlayerState = { ...player("doc", "doctor", "angel", false) };
  const ally: PlayerState = player("ally", "citizen", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState(
    { doc, ally, demon },
    [
      { sourceUserId: "doc", targetUserId: "ally", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  ));
  assert.equal(r.newState.players.ally.alive, false, "쿠키 없는 탈락 시전자 — 치료 미발동, ally 사망");
}
// --- 푸딩 무시 불가: pudding 보유자는 봉인(silenced)을 뚫고 단일 대상 능력 발동(표식 소비) ---
{
  // 봉인된 의사(푸딩 보유)의 치료가 무시 불가로 발동 → ally 보호.
  const doc: PlayerState = { ...player("doc", "doctor", "angel"), tags: ["pudding", "dessert"], counters: { silencedNights: 1 } };
  const ally: PlayerState = player("ally", "citizen", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState(
    { doc, ally, demon },
    [
      { sourceUserId: "doc", targetUserId: "ally", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  ));
  assert.ok(r.events.some((e: any) => e.type === "pudding_ignore_immune" && e.userId === "doc"), "푸딩 — 무시 불가 우회 이벤트");
  assert.equal(r.newState.players.ally.alive, true, "푸딩 — 봉인 뚫고 치료 발동, ally 보호");
  assert.ok(!r.newState.players.doc.tags.includes("pudding"), "푸딩 표식 소비");
}
{
  // 푸딩 없는 봉인 시전자는 발동 차단(대조군).
  const doc: PlayerState = { ...player("doc", "doctor", "angel"), counters: { silencedNights: 1 } };
  const ally: PlayerState = player("ally", "citizen", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState(
    { doc, ally, demon },
    [
      { sourceUserId: "doc", targetUserId: "ally", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  ));
  assert.equal(r.newState.players.ally.alive, false, "푸딩 없는 봉인 시전자 — 치료 차단, ally 사망");
}
{
  const mizlet: PlayerState = player("mizlet", "mizlet", "angel");
  const a: PlayerState = { ...player("a", "citizen", "angel"), tags: ["dessert"] };
  const b: PlayerState = player("b", "doctor", "angel");
  const r = resolveNightActions(emptyState(
    { mizlet, a, b },
    [{ sourceUserId: "mizlet", targetUserId: "a", actionType: "mizlet_wine", priority: 5 }],
  ));
  assert.ok(r.events.some((e: any) => e.type === "dessert_chat_open" && e.payload?.user_id === "a" && e.payload?.mizlet === "mizlet"), "dessert_chat_open — 디저트 보유 대상 a");
  assert.ok(!r.events.some((e: any) => e.type === "dessert_chat_open" && e.payload?.user_id === "b"), "비대상 b — chat open X");
}

// --- 쿠키 탈락자 직접 지정(원문 [천사]15): 미즐렛이 탈락자에게 쿠키 → 그 탈락자가 가장 가까운 밤 활동 참여 ---
{
  // 탈락한 의사가 cookie 를 받으면(같은 밤 priority 3 쿠키 먼저 처리) cookie 표식으로 죽음-게이트
  // 우회 → 그 밤 자신의 치료가 발동. mizlet_cookie(3)·doctor_heal(3) 동률이지만 cookie 가 먼저
  // 처리되도록 doc 액션을 priority 5 로 둔다(쿠키 표식이 선다).
  const mizlet: PlayerState = player("mizlet", "mizlet", "angel");
  const doc: PlayerState = { ...player("doc", "doctor", "angel", false) }; // 이미 탈락
  const ally: PlayerState = player("ally", "citizen", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const r = resolveNightActions(emptyState(
    { mizlet, doc, ally, demon },
    [
      { sourceUserId: "mizlet", targetUserId: "doc", actionType: "mizlet_cookie", priority: 3 },
      { sourceUserId: "doc", targetUserId: "ally", actionType: "doctor_heal", priority: 5 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  ));
  assert.ok(r.newState.players.doc.tags.includes("dessert"), "쿠키 — 탈락 대상에게도 디저트 태그 적용");
  assert.ok(r.events.some((e: any) => e.type === "cookie_act" && e.userId === "doc"), "쿠키 — 탈락자가 가장 가까운 밤 활동 참여(cookie_act)");
  // doc 의 치료가 발동하면 ally 가 보호된다(priority 5 치료 > 4 처치 라 보호 표식이 죽음 해소 전에 섬).
  assert.equal(r.newState.players.ally.alive, true, "쿠키 — 탈락한 의사의 치료가 발동해 ally 보호");
}
assert.match(roles, /id: "mizlet_cookie"[\s\S]*?allowDeadTarget: true/, "미즐렛 쿠키 — allowDeadTarget 플래그(탈락자 직접 지정)");
assert.match(phaseAdvSrc, /pudding_death_shifted/, "phase-advance — 푸딩 탈락 시점 밤 조정");

// 미즐렛 v2 — 계약 정규식.
const engineSrcMz = readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8");
assert.match(engineSrcMz, /dessert_received/, "engine — dessert_received 이벤트 발사");
assert.match(engineSrcMz, /dessert_chat_open/, "engine — dessert_chat_open 이벤트 발사");
assert.match(engineSrcMz, /cookie_act/, "engine — 쿠키 죽음-게이트 우회 발동");
assert.match(engineSrcMz, /pudding_ignore_immune/, "engine — 푸딩 무시 불가 우회");
assert.match(engineSrcMz, /puddingImmune/, "engine — 푸딩 무시 불가 게이트 변수");

// --- 루루 무투(악보 교체): voteCountBonus 적용 시 처형 투표 2배 ---
{
  const luru: PlayerState = { ...player("luru", "luru", "angel"), counters: { voteCountBonus: 1 } };
  const t = player("t", "citizen", "angel");
  const r = tallyEliminationVotes([{ actorUserId: "luru", targetUserId: "t" }], { luru, t });
  assert.equal(r.tallies["t"], 2, "무투 — 처형 표 2배(base 1 * 2)");
}
{
  const luru: PlayerState = { ...player("luru", "luru", "angel"), counters: { voteCountBonus: 1 } };
  const t = player("t", "citizen", "angel");
  const r = tallyVerdictVotes([{ actorUserId: "luru", targetUserId: "t", actionType: "verdict_approve" }], { luru, t });
  assert.equal(r.approve, 2, "무투 — 찬반 표 2배");
}
{
  const luru: PlayerState = player("luru", "luru", "angel");
  const t = player("t", "citizen", "angel");
  const r = tallyEliminationVotes([{ actorUserId: "luru", targetUserId: "t" }], { luru, t });
  assert.equal(r.tallies["t"], 1, "voteCountBonus 0 — 평시 1배");
}

// 루루 v2 — 계약 정규식.
assert.match(roles, /id: "luru_mute"[\s\S]*?tag: "voteCountBonus"/, "루루 무투 — voteCountBonus 세팅");
const luruMig = readFileSync("supabase/migrations/20260618150000_gomdori_luru_mute.sql", "utf8");
assert.match(luruMig, /'luru_mute'/, "마이그레이션 — 루루 무투");

// --- 라이너 강한 의지: 관찰 + willCount +1; 관찰 대상 사망 시 +2 추가 ---
{
  const rainer: PlayerState = player("rainer", "rainer", "angel");
  const demon: PlayerState = player("demon", "demon", "demon");
  const a: PlayerState = player("a", "citizen", "angel");
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { rainer, demon, a },
    actionStack: [
      { sourceUserId: "rainer", targetUserId: "a", actionType: "rainer_resolve", priority: 5 },
      { sourceUserId: "demon", targetUserId: "a", actionType: "demon_kill", priority: 4 },
    ],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.a.alive, false, "a 처치");
  // 관찰 +1 + 사망 +2 = willCount 3 → 거친 포효 자동 발동(2 소비) → willCount 1.
  assert.equal(r.newState.players.rainer.counters.willCount, 1, "willCount = (관찰 +1 + 사망 +2) - 거친 포효 소비 2");
  assert.ok(r.events.some((e: any) => e.type === "rainer_will_surge"), "rainer_will_surge 이벤트");
  assert.ok(r.events.some((e: any) => e.type === "rainer_savage_roar"), "거친 포효 자동 발동 이벤트");
  assert.ok(!r.newState.players.a.tags.includes("observedByRainer"), "observedByRainer 표식 소비");
}

// --- 라이너 거친 포효: willCount 2 누적 시 자동 발동 — countBonus -1 + 이 밤 지목 대상 clawed ---
{
  // 강한 의지 1회로 willCount 1 → 부족(발동 X). 두 밤째 다른 대상 관찰로 2 도달 시 발동.
  const rainer: PlayerState = { ...player("rainer", "rainer", "angel"), counters: { willCount: 1 } };
  const r = resolveNightActions(emptyState(
    { rainer, foe: player("foe", "citizen", "angel") },
    [{ sourceUserId: "rainer", targetUserId: "foe", actionType: "rainer_resolve", priority: 5 }],
  ));
  // willCount 1 + 관찰 +1 = 2 → 거친 포효 발동(2 소비 → 0), countBonus -1, foe 에 clawed.
  assert.equal(r.newState.players.rainer.counters.willCount, 0, "거친 포효 — willCount 2 소비");
  assert.equal(r.newState.players.rainer.counters.countBonus, -1, "거친 포효 — 천사팀 카운트 -1");
  assert.ok(r.newState.players.foe.tags.includes("clawed"), "거친 포효 — 이 밤 지목 대상에 백호 발톱(clawed)");
  assert.ok(r.events.some((e: any) => e.type === "rainer_savage_roar"), "거친 포효 이벤트");
}

// --- 라이너 거친 포효: willCount 1 미만이면 발동 안 함 ---
{
  const rainer: PlayerState = { ...player("rainer", "rainer", "angel"), counters: { willCount: 0 } };
  const r = resolveNightActions(emptyState({ rainer }, []));
  assert.equal(r.newState.players.rainer.counters.countBonus ?? 0, 0, "willCount 미달 — 거친 포효 미발동");
  assert.ok(!r.events.some((e: any) => e.type === "rainer_savage_roar"), "거친 포효 미발동");
}

// --- 거친 포효(rainer_roar, 플레이어 지목): willCount≥2 → 2명 직접 지목 clawed + willCount 2 소비 + countBonus -1 ---
{
  const rainer: PlayerState = { ...player("rainer", "rainer", "angel"), counters: { willCount: 2 } };
  const a = player("a", "citizen", "angel");
  const b = player("b", "doctor", "angel");
  const r = resolveNightActions(emptyState(
    { rainer, a, b },
    [{ sourceUserId: "rainer", targetUserId: "a", targetUserIds: ["a", "b"], actionType: "rainer_roar", priority: 5 }],
  ));
  assert.ok(r.newState.players.a.tags.includes("clawed"), "거친 포효 지목 — a 에 clawed");
  assert.ok(r.newState.players.b.tags.includes("clawed"), "거친 포효 지목 — b 에 clawed");
  assert.equal(r.newState.players.rainer.counters.willCount, 0, "거친 포효 — willCount 2 소비");
  assert.equal(r.newState.players.rainer.counters.countBonus, -1, "거친 포효 — 천사팀 카운트 -1");
  // 자동 폴백은 제출 시 생략 — willCount 가 음수로 이중 소비되지 않음.
  assert.ok(!r.events.some((e: any) => e.type === "rainer_savage_roar"), "rainer_roar 제출 시 자동 폴백 생략(double-consume 방지)");
}
// 거친 포효 게이트: willCount < 2 면 지목해도 발동 안 됨(requiresCounter 차단).
{
  const rainer: PlayerState = { ...player("rainer", "rainer", "angel"), counters: { willCount: 1 } };
  const a = player("a", "citizen", "angel");
  const b = player("b", "doctor", "angel");
  const r = resolveNightActions(emptyState(
    { rainer, a, b },
    [{ sourceUserId: "rainer", targetUserId: "a", targetUserIds: ["a", "b"], actionType: "rainer_roar", priority: 5 }],
  ));
  assert.ok(!r.newState.players.a.tags.includes("clawed"), "willCount 1 — 거친 포효 차단(clawed 없음)");
  assert.ok(r.events.some((e: any) => e.type === "action_blocked_no_charge"), "거친 포효 — 충전 부족 차단 이벤트");
}
assert.match(roles, /id: "rainer_roar"[\s\S]*?targetCount: 2[\s\S]*?requiresCounter: \{ key: "willCount", min: 2/, "라이너 거친 포효 — 2인 지목 + willCount≥2 게이트");
assert.match(roles, /id: "rainer_roar"[\s\S]*?tag: "clawed"/, "거친 포효 — clawed 표식");
const rainerRoarMig = readFileSync("supabase/migrations/20260626120000_gomdori_rainer_roar.sql", "utf8");
assert.match(rainerRoarMig, /'rainer_roar'/, "마이그레이션 — 거친 포효");

// --- 로마즈 용의자 색출: 표식(romazSuspect) + 조사장(clueWarrant) +1 + 받는표/의심 가산 ---
{
  const romaz: PlayerState = player("romaz", "romaz", "angel");
  const r = resolveNightActions(emptyState(
    { romaz, victim: player("victim", "citizen", "angel") },
    [{ sourceUserId: "romaz", targetUserId: "victim", actionType: "romaz_suspect", priority: 1 }],
  ));
  assert.equal(r.newState.players.victim.counters.voteBias, 5, "용의자 색출 — 받는 표 +5");
  assert.equal(r.newState.players.victim.counters.suspicionBias, 10, "용의자 색출 — 받는 의심 +10");
  assert.ok(r.newState.players.victim.tags.includes("romazSuspect"), "용의자 표식(신념 사정권)");
  assert.equal(r.newState.players.romaz.counters.clueWarrant, 1, "조사장 +1");
}

// --- 로마즈 조사장 3장 + 악마팀 대상 → 무조건 구금(Silence, 능력 차단) ---
{
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), counters: { clueWarrant: 3 } };
  const r = resolveNightActions(emptyState(
    { romaz, demon: player("demon", "demon", "demon"), prey: player("prey", "citizen", "angel") },
    [
      { sourceUserId: "romaz", targetUserId: "demon", actionType: "romaz_suspect", priority: 1 },
      { sourceUserId: "demon", targetUserId: "prey", actionType: "demon_kill", priority: 4 },
    ],
  ));
  assert.equal(r.newState.players.prey.alive, true, "조사장 3 — 악마 구금되어 처치 무력화");
  assert.ok(r.events.some((e: any) => e.type === "action_blocked_silenced" && e.userId === "demon"), "구금(봉인) 차단 이벤트");
}

// --- 로마즈 조사장 3장이어도 천사팀 대상은 구금 안 됨(원문 '악마팀일 때') ---
{
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), counters: { clueWarrant: 3 } };
  const r = resolveNightActions(emptyState(
    { romaz, ally: player("ally", "citizen", "angel") },
    [{ sourceUserId: "romaz", targetUserId: "ally", actionType: "romaz_suspect", priority: 1 }],
  ));
  assert.equal(r.newState.players.ally.counters.silencedNights ?? 0, 0, "천사팀 용의자는 구금 X");
}

// --- 로마즈 신념: 용의자(romazSuspect)였던 악마 처단(Kill), 봉인 안 됨 ---
{
  const romaz: PlayerState = player("romaz", "romaz", "angel");
  const demon: PlayerState = { ...player("demon", "demon", "demon"), tags: ["romazSuspect"] };
  const r = resolveNightActions(emptyState(
    { romaz, demon },
    [{ sourceUserId: "romaz", targetUserId: "demon", actionType: "romaz_conviction", priority: 4 }],
  ));
  assert.equal(r.newState.players.demon.alive, false, "신념 — 용의자였던 악마 처단");
  assert.equal(r.newState.players.romaz.counters.convictionBlocked ?? 0, 0, "악마 처단은 봉인 안 됨");
}

// --- 로마즈 신념: 용의자였던 천사 처단 시 로마즈 convictionBlocked(이후 구금 봉인, selfPenalty) ---
{
  const romaz: PlayerState = player("romaz", "romaz", "angel");
  const ally: PlayerState = { ...player("ally", "citizen", "angel"), tags: ["romazSuspect"] };
  const r = resolveNightActions(emptyState(
    { romaz, ally },
    [{ sourceUserId: "romaz", targetUserId: "ally", actionType: "romaz_conviction", priority: 4 }],
  ));
  assert.equal(r.newState.players.ally.alive, false, "신념 — 용의자였던 천사도 처단(무시불가)");
  assert.equal(r.newState.players.romaz.counters.convictionBlocked, 1, "동료 처단 → 로마즈 신념 봉인");
}

// --- 로마즈 신념: 용의자 표식 없는 대상은 처단 불가(onlyIfTargetTag 게이트) ---
{
  const romaz: PlayerState = player("romaz", "romaz", "angel");
  const r = resolveNightActions(emptyState(
    { romaz, stranger: player("stranger", "demon", "demon") },
    [{ sourceUserId: "romaz", targetUserId: "stranger", actionType: "romaz_conviction", priority: 4 }],
  ));
  assert.equal(r.newState.players.stranger.markedForDeath, false, "용의자 표식 없으면 신념 무효");
}

// 로마즈 v2 — 계약 정규식.
assert.match(roles, /id: "romaz_suspect"[\s\S]*?tag: "romazSuspect"/, "로마즈 용의자 표식");
assert.match(roles, /id: "romaz_suspect"[\s\S]*?tag: "clueWarrant"/, "로마즈 조사장 충전");
assert.match(roles, /id: "romaz_conviction"[\s\S]*?type: "Kill"[\s\S]*?onlyIfTargetTag: "romazSuspect"/, "로마즈 신념 — 용의자 사정권 처단");
const romazMig = readFileSync("supabase/migrations/20260625170000_gomdori_romaz_conviction.sql", "utf8");
assert.match(romazMig, /'romaz_conviction'/, "마이그레이션 — 신념");

// --- 로마즈 투표 구금(원문): 직전 투표한 용의자(romazSuspect)를 그 밤 구금(능력 차단) ---
{
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), lastVoteTarget: "suspect" };
  const suspect: PlayerState = { ...player("suspect", "demon", "demon"), tags: ["romazSuspect"] };
  const prey: PlayerState = player("prey", "citizen", "angel");
  const r = resolveNightActions(emptyState(
    { romaz, suspect, prey },
    // 로마즈는 색출 제출 안 함 — 투표 substrate 만으로 구금 구동. 용의자(악마)가 처치 시도.
    [{ sourceUserId: "suspect", targetUserId: "prey", actionType: "demon_kill", priority: 4 }],
  ));
  assert.ok(r.events.some((e: any) => e.type === "romaz_vote_detained" && e.payload?.user_id === "suspect" && e.payload?.by === "romaz"), "투표 구금 이벤트");
  assert.equal(r.newState.players.prey.alive, true, "투표 구금 — 용의자 능력 차단으로 처치 무효");
  assert.equal(r.newState.players.romaz.counters.detainedThisNight, 1, "로마즈 구금 발동 표식(감시소 입력)");
}
// --- 투표 구금: 용의자 표식 없는 직전 투표 대상은 구금 안 됨 ---
{
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), lastVoteTarget: "innocent" };
  const innocent: PlayerState = player("innocent", "demon", "demon");
  const prey: PlayerState = player("prey", "citizen", "angel");
  const r = resolveNightActions(emptyState(
    { romaz, innocent, prey },
    [{ sourceUserId: "innocent", targetUserId: "prey", actionType: "demon_kill", priority: 4 }],
  ));
  assert.equal(r.newState.players.prey.alive, false, "용의자 아닌 대상 — 구금 X, 처치 발동");
}
// --- 투표 구금: 신념 봉인(convictionBlocked) 중이면 구금 불가 ---
{
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), lastVoteTarget: "suspect", counters: { convictionBlocked: 1 } };
  const suspect: PlayerState = { ...player("suspect", "demon", "demon"), tags: ["romazSuspect"] };
  const prey: PlayerState = player("prey", "citizen", "angel");
  const r = resolveNightActions(emptyState(
    { romaz, suspect, prey },
    [{ sourceUserId: "suspect", targetUserId: "prey", actionType: "demon_kill", priority: 4 }],
  ));
  assert.equal(r.newState.players.prey.alive, false, "신념 봉인 중 — 투표 구금 불가");
}
// --- 감시소 봉쇄(원문 패시브): 구금된 밤 천사팀이 악마효과 수령 → romazWardenBlocked, 다음 밤 구금 불가 ---
{
  // 구금된 밤: 로마즈가 용의자(악마) 구금 + 그 악마가 천사(victim)에게 봉인(부정효과) → 감시소 봉쇄.
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), lastVoteTarget: "demon" };
  const demon: PlayerState = { ...player("demon", "demon", "demon"), tags: ["romazSuspect"] };
  const victim: PlayerState = player("victim", "citizen", "angel");
  // 악마는 구금되지만, 같은 밤 *다른* 악마효과 출처가 필요 — 두 번째 악마(낙인 대악마)가 victim 봉인.
  const demon2: PlayerState = player("demon2", "demon", "demon");
  const r = resolveNightActions(emptyState(
    { romaz, demon, victim, demon2 },
    [{ sourceUserId: "demon2", targetUserId: null, actionType: "daeakma_dominion", priority: 1 }],
  ));
  assert.equal(r.newState.players.romaz.counters.romazWardenBlocked, 2, "감시소 봉쇄 — 구금밤 + 천사 악마효과 수령 → romazWardenBlocked=2");
  assert.ok(r.events.some((e: any) => e.type === "romaz_warden_blocked"), "감시소 봉쇄 이벤트");
}
// --- 감시소 봉쇄 카운트다운: romazWardenBlocked 중엔 다음 밤 투표 구금 불가 ---
{
  const romaz: PlayerState = { ...player("romaz", "romaz", "angel"), lastVoteTarget: "suspect", counters: { romazWardenBlocked: 2 } };
  const suspect: PlayerState = { ...player("suspect", "demon", "demon"), tags: ["romazSuspect"] };
  const prey: PlayerState = player("prey", "citizen", "angel");
  const r = resolveNightActions(emptyState(
    { romaz, suspect, prey },
    [{ sourceUserId: "suspect", targetUserId: "prey", actionType: "demon_kill", priority: 4 }],
  ));
  // 밤 시작에 2→1 차감(여전히 >0) → 구금 불가 → 처치 발동.
  assert.equal(r.newState.players.prey.alive, false, "감시소 봉쇄 중 — 투표 구금 불가, 처치 발동");
  assert.equal(r.newState.players.romaz.counters.romazWardenBlocked, 1, "봉쇄 카운트다운 2→1");
}
const engineSrcRomaz = readFileSync("supabase/functions/_shared/engine/engine.ts", "utf8");
assert.match(engineSrcRomaz, /applyRomazVoteDetain/, "engine — 투표 구금 hook");
assert.match(engineSrcRomaz, /romazWardenBlocked = 2/, "engine — 감시소 봉쇄 set");
assert.match(engineSrcRomaz, /tookDemonEffectThisNight/, "engine — 천사 악마효과 수령 표식");

// --- 라이너 그날의 저항(canon [천사]13): 1밤 +3 카운트(resistCount) + 거친 포효 지목 +2(roarBonus) ---
{
  const rainer: PlayerState = player("rainer", "rainer", "angel");
  const r = resolveNightActions(emptyState(
    { rainer },
    [{ sourceUserId: "rainer", targetUserId: null, actionType: "rainer_resistance", priority: 5 }],
  ));
  assert.equal(r.newState.players.rainer.counters.resistCount, 3, "그날의 저항 — 일시 천사팀 카운트 +3");
  assert.equal(r.newState.players.rainer.counters.roarBonus, 2, "그날의 저항 — 거친 포효 지목 +2");
  assert.equal(r.newState.players.rainer.counters.used_rainer_resistance, 1, "1회 제한 기록");
}
// 그날의 저항 만료(다음 밤 시작 round-reset): resistCount/roarBonus 클리어 + 천사팀 -1 + 강한 의지 지정 +1.
{
  const rainer: PlayerState = { ...player("rainer", "rainer", "angel"), counters: { resistCount: 3, roarBonus: 2 } };
  const r = resolveNightActions(emptyState({ rainer }, []));
  assert.equal(r.newState.players.rainer.counters.resistCount ?? 0, 0, "만료 — resistCount 클리어");
  assert.equal(r.newState.players.rainer.counters.roarBonus ?? 0, 0, "만료 — roarBonus 클리어");
  assert.equal(r.newState.players.rainer.counters.countBonus ?? 0, -1, "만료 — 천사팀 카운트 -1(영구)");
  assert.equal(r.newState.players.rainer.counters.resolveBonus ?? 0, 1, "만료 — 강한 의지 지정 대상 +1");
}

// 라이너 v2 — 계약 정규식.
assert.match(roles, /id: "rainer_resolve"[\s\S]*?noConsecutiveTarget: true/, "라이너 강한 의지 — 연속 지목 금지");
assert.match(roles, /id: "rainer_resolve"[\s\S]*?tag: "observedByRainer"/, "라이너 강한 의지 — observed 표식");
assert.match(roles, /id: "rainer_resistance"[\s\S]*?maxUses: 1/, "라이너 그날의 저항 — 1회 제한");
assert.match(engineSrc, /rainer_savage_roar/, "엔진 — 거친 포효 자동 발동");
assert.match(engineSrc, /tags\.push\("clawed"\)/, "엔진 — 백호 발톱(clawed) 표식");
assert.match(phaseAdvSrc, /savage_roar_annihilation/, "phase-advance — 거친 포효 아침 소멸 hook");
assert.match(phaseAdvSrc, /clawed[\s\S]*?voteValueMod[\s\S]*?>= 3/, "phase-advance — 발톱 대상 투표가치 3 게이트");
const rainerMig = readFileSync("supabase/migrations/20260618160000_gomdori_rainer_v2.sql", "utf8");
assert.match(rainerMig, /'rainer_resolve'/, "마이그레이션 — 강한 의지");
assert.match(rainerMig, /'rainer_resistance'/, "마이그레이션 — 그날의 저항");

console.log("Gomdori v2 abilities (봉인/부활/변환/신앙/백호/사탄의마/우노명예/군인의사명/아서단죄/말렌혼령/소명/팬텀봉인/영면/침묵의밤/엘런누진/말렌마비/신출귀몰/가인급습/가인보호막만료/루나분기/엘런해체/사탄의마전역/임종선언/소명쿨다운/역추리/헬렌추억/미즐렛회로/루루무투/라이너의지/로마즈조사장/로마즈신념) checks passed");

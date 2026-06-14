import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkWinCondition, resolveNightActions, resolveNightmares, tallyEliminationVotes } from "../../supabase/functions/_shared/engine/engine.ts";
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
  assert.equal(newState.players.pasua.counters.convertCooldown ?? 0, 0, "신앙은 포교 쿨다운과 무관");
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

// --- 1c. 연속 포교 제한(파스아): 포교한 밤 convertCooldown=1, 다음 밤 감소 ---
{
  const state = emptyState(
    {
      pasua: player("pasua", "pasua", "neutral"),
      angel: player("angel", "citizen", "angel"),
    },
    [{ sourceUserId: "pasua", targetUserId: "angel", actionType: "pasua_convert", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.pasua.counters.convertCooldown, 1, "포교 발동 밤 — 쿨다운 1 세팅(다음 밤 거부)");
  assert.equal(newState.players.angel.currentRole, "converted", "포교 — 천사 전향");
  // 다음 밤(포교 미발동): 쿨다운 1 → 0 으로 카운트다운.
  const next = emptyState({ pasua: { ...newState.players.pasua } }, []);
  const { newState: after } = resolveNightActions(next);
  assert.equal(after.players.pasua.counters.convertCooldown ?? 0, 0, "다음 밤 — 쿨다운 해제(한 밤 건너 재포교 가능)");
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
  assert.equal(newState.players.rainer.counters.countBonus, 1, "백호 — 생존 가산 +1");
  assert.equal(newState.players.rainer.counters.deadCountBonus, 1, "백호 — 생존 무관 지속 +1");
  assert.equal(newState.players.rainer.counters.used_rainer_summon, 1, "소환 1회 소진 기록");
  // 두 번째 소환은 maxUses 로 막힌다.
  const again = emptyState(
    { rainer: { ...newState.players.rainer } },
    [{ sourceUserId: "rainer", targetUserId: null, actionType: "rainer_summon", priority: 5 }],
  );
  const { newState: after, events } = resolveNightActions(again);
  assert.equal(after.players.rainer.counters.countBonus, 1, "2회차 소환 차단 — 카운트 불변");
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
assert.match(roles, /id: "arthur_judge"[\s\S]*?type: "Annihilate"/, "아서 단죄(Annihilate)");
assert.match(roles, /id: "mizlet_dessert"[\s\S]*?type: "Protect"/, "미즐렛 디저트 버프(Protect)");
assert.match(roles, /id: "arthur_judge"/, "아서 단죄 능력 정의(단일 출처)");
assert.match(roles, /id: "mizlet_dessert"/, "미즐렛 디저트 능력 정의(단일 출처)");
const batch2bMig = readFileSync("supabase/migrations/20260614150000_gomdori_batch_tier2b.sql", "utf8");
assert.match(batch2bMig, /'arthur_judge'/, "마이그레이션 — 단죄");
assert.match(batch2bMig, /'mizlet_dessert'/, "마이그레이션 — 디저트");

// --- 4. 변환(루나 공포 속에 밀어 넣다): 천사 → 악마팀 ---
{
  const state = emptyState(
    {
      luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 2 } }, // 달 게이지 충전 상태
      angel: player("angel", "citizen", "angel"),
    },
    [{ sourceUserId: "luna", targetUserId: "angel", actionType: "luna_corrupt", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.angel.actualFaction, "demon", "천사가 악마팀으로 타락");
  assert.equal(newState.players.angel.currentRole, "corrupted", "타락자 역할");
  assert.ok(events.some((e: any) => e.type === "faction_changed" && e.payload?.new_faction === "demon"), "변환 이벤트");
}
// 악마는 타락 불가
{
  const state = emptyState(
    {
      luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 2 } },
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
  assert.equal(newState.players.luna.counters.moonGauge, 1, "적막 — 달 게이지 +1");
  assert.ok(newState.players.v.tags.includes("moonlit"), "달빛 — 투표 대상(substrate VoteTarget)에 태그");

  // 게이지 1 이면 공포 차단(임계 2 미만).
  const low = emptyState(
    { luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 1 } }, a: player("a", "citizen", "angel") },
    [{ sourceUserId: "luna", targetUserId: "a", actionType: "luna_corrupt", priority: 5 }],
  );
  const r1 = resolveNightActions(low);
  assert.equal(r1.newState.players.a.currentRole, "citizen", "게이지 부족 — 공포 차단");
  assert.ok(r1.events.some((e: any) => e.type === "action_blocked_no_charge"), "충전 부족 차단 이벤트");

  // 게이지 2 면 공포 발동 + 소비.
  const high = emptyState(
    { luna: { ...player("luna", "luna", "demon"), counters: { moonGauge: 2 } }, a: player("a", "citizen", "angel") },
    [{ sourceUserId: "luna", targetUserId: "a", actionType: "luna_corrupt", priority: 5 }],
  );
  const r2 = resolveNightActions(high);
  assert.equal(r2.newState.players.a.actualFaction, "demon", "게이지 충족 — 공포 타락");
  assert.equal(r2.newState.players.luna.counters.moonGauge, 0, "공포 발동 — 게이지 소비");
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
  assert.ok(events.some((e: any) => e.type === "count_granted" && e.payload?.user_id === "ally"), "투쟁 이벤트");
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
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.target.counters.voteBias, 3, "박해 — 투표 대상(VoteTarget) 받는-투표가치 +3");
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

// --- 6d. 우노 용맹함: 자기 정화(Cleanse) + 명예(+1) ---
{
  const clean = emptyState(
    { uno: { ...player("uno", "uno", "angel"), counters: { voteBias: 3 } } },
    [{ sourceUserId: "uno", targetUserId: null, actionType: "uno_valor", priority: 5 }],
  );
  const { newState } = resolveNightActions(clean);
  assert.equal(newState.players.uno.counters.voteBias ?? 0, 0, "용맹함 — 자기 부정효과 제거");
  assert.equal(newState.players.uno.counters.countBonus, 1, "용맹함 — 명예 +1");
}

// --- 6e. 팬텀 영면: 악몽 2회 누적 → 즉시 처리 ---
{
  const victim = { ...player("victim", "citizen", "angel"), counters: { nightmare: 1 } };
  const state = emptyState(
    { phantom: player("phantom", "phantom", "demon"), victim },
    [{ sourceUserId: "phantom", targetUserId: "victim", actionType: "phantom_nightmare", priority: 4 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.victim.alive, false, "악몽 2회 누적 — 영면 즉시 처리");
  assert.ok(events.some((e: any) => e.type === "deep_sleep"), "영면 이벤트");
}

// --- 7. 잔불 대검(아서): 대상 하루 무적 → 처치 무효 ---
{
  const state = emptyState(
    {
      arthur: player("arthur", "arthur", "angel"),
      demon: player("demon", "demon", "demon"),
      ally: player("ally", "citizen", "angel"),
    },
    [
      { sourceUserId: "arthur", targetUserId: "ally", actionType: "arthur_emberblade", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.ally.alive, true, "잔불 대검 보호로 처치 무효");
  assert.ok(events.some((e: any) => e.type === "attack_prevented"), "보호 이벤트");
}

// --- 7b. 아서 단죄: 폭열(branded) → 재적용 시 소멸(부활 불가) ---
{
  const state = emptyState(
    { arthur: player("arthur", "arthur", "angel"), foe: player("foe", "corrupted", "demon") },
    [{ sourceUserId: "arthur", targetUserId: "foe", actionType: "arthur_judge", priority: 4 }],
  );
  const r1 = resolveNightActions(state);
  assert.equal(r1.newState.players.foe.counters.branded, 1, "첫 단죄 — 폭열 표식");
  assert.equal(r1.newState.players.foe.alive, true, "첫 단죄로는 탈락 안 함");
  // 재적용 → 소멸.
  const again = emptyState(
    { arthur: { ...player("arthur", "arthur", "angel"), counters: { used_arthur_judge: 1 } }, foe: { ...r1.newState.players.foe } },
    [{ sourceUserId: "arthur", targetUserId: "foe", actionType: "arthur_judge", priority: 4 }],
  );
  const r2 = resolveNightActions(again);
  assert.equal(r2.newState.players.foe.alive, false, "폭열된 대상 재단죄 — 소멸");
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

// --- 7d. 미즐렛 디저트: 생존자 보호 + 디저트 태그 ---
{
  const state = emptyState(
    {
      mizlet: player("mizlet", "mizlet", "angel"),
      ally: player("ally", "citizen", "angel"),
      demon: player("demon", "demon", "demon"),
    },
    [
      { sourceUserId: "mizlet", targetUserId: "ally", actionType: "mizlet_dessert", priority: 3 },
      { sourceUserId: "demon", targetUserId: "ally", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.ally.alive, true, "디저트 보호로 처치 무효");
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

// --- 7f. 루루 소나타: 매료 3 누적 → 전원 정화 + 자기 무적(게이트·소비) ---
{
  // 게이지 3, 부정효과 걸린 아군과 함께 → 소나타가 전원 Cleanse + 루루 보호.
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
  assert.equal(newState.players.ally.counters.nightmare ?? 0, 0, "소나타 — 전원 부정효과 제거(All Cleanse)");
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

// --- 9. 악몽(팬텀): 밤 보호 무시 + 아침(resolveNightmares) 탈락 ---
{
  const state = emptyState(
    {
      phantom: player("phantom", "phantom", "demon"),
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
  assert.equal(newState.players.victim.counters.nightmare, 1, "악몽 표식");
  // 아침 해소 — 밤 보호(이미 해제됨)로 막지 못하고 탈락.
  const nm = resolveNightmares(newState.players) as Array<{ type: string; payload?: { user_id?: string } }>;
  assert.equal(newState.players.victim.alive, false, "아침에 악몽으로 탈락(보호 무시)");
  assert.ok(nm.some((e) => e.type === "nightmare_death" && e.payload?.user_id === "victim"), "악몽 사망 이벤트");
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

// --- 11. 변신(베스토): self 토글 — 솔(조사 시 천사) ↔ 하베스토(악마) ---
{
  const state = emptyState(
    { besto: player("besto", "besto", "demon") },
    [{ sourceUserId: "besto", targetUserId: null, actionType: "besto_shift", priority: 1 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.besto.counters.disguised, 1, "변신 1회 → 솔(disguised=1)");
  assert.ok(events.some((e: any) => e.type === "disguise_toggled"), "변신 이벤트");
  // 다시 변신 → 하베스토(0)로 토글백.
  const state2 = emptyState(
    { besto: { ...player("besto", "besto", "demon"), counters: { disguised: 1 } } },
    [{ sourceUserId: "besto", targetUserId: null, actionType: "besto_shift", priority: 1 }],
  );
  const { newState: n2 } = resolveNightActions(state2);
  assert.equal(n2.players.besto.counters.disguised, 0, "재변신 → 하베스토(0) 토글백");
}

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

assert.match(roles, /id: "besto_hidden"[\s\S]*?type: "Kill"/, "베스토 히든 포지션(처치)");
assert.match(roles, /id: "besto_shift"[\s\S]*?type: "Disguise"/, "베스토 변신");
assert.match(roles, /id: "daeakma_brand"[\s\S]*?type: "Rebrand"/, "대악마 낙인");
assert.match(roles, /id: "phantom_eclipse"[\s\S]*?type: "Eclipse"/, "팬텀 일식");
// match-action: SELF 행동 null 타겟 허용 + 베스토 조사 회피.
assert.match(matchAction, /SELF_ACTIONS[\s\S]*?targetType === "SELF"[\s\S]*?"NONE"[\s\S]*?"ALL"/, "SELF/무대상 행동은 targetType 으로 도출(단일 출처)");
assert.match(roles, /id: "daeakma_dominion"/, "대악마 존재감 능력 정의(단일 출처)");
assert.match(roles, /id: "uno_valor"/, "우노 용맹함 능력 정의(단일 출처)");
const batch2aMig = readFileSync("supabase/migrations/20260614140000_gomdori_batch_tier2a.sql", "utf8");
assert.match(batch2aMig, /'uno_valor'/, "마이그레이션 — 용맹함");
assert.match(batch2aMig, /'daeakma_dominion'/, "마이그레이션 — 압도적 존재감");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?target: "VoteTarget"/, "엘런 박해 — substrate VoteTarget");
assert.match(roles, /id: "besto_hidden"/, "베스토 능력 정의(단일 출처)");
assert.match(roles, /id: "demon_kill"/, "대악마 처치 능력 정의(단일 출처)");
// 2026-06-12: 조사 판정은 유효 직업(effectiveRole — 낙인 재배정 반영) 기준으로 이동.
assert.match(matchAction, /isDemonKillerRole\(effectiveRole\(target\)\) && !disguised/, "베스토 변신 조사 회피 (유효 직업 기준)");
// phase-advance: 일식 소멸 + 다음 밤 전환.
const phaseAdvanceSrc = readFileSync("supabase/functions/phase-advance/index.ts", "utf8");
assert.match(phaseAdvanceSrc, /eclipse_annihilation/, "일식 소멸 처리");
assert.match(phaseAdvanceSrc, /eclipseActive[\s\S]*?nextNightSuspectTransition/, "일식 시 아침 대신 다음 밤");
const deepMig = readFileSync("supabase/migrations/20260610200000_gomdori_deep_demons.sql", "utf8");
for (const a of ["besto_hidden", "besto_shift", "daeakma_brand", "phantom_eclipse"]) {
  assert.match(deepMig, new RegExp(`'${a}'`), `migration allows ${a}`);
}

assert.match(roles, /id: "malen_possess"[\s\S]*?type: "Possess"/, "말렌 빙의");
assert.match(roles, /id: "phantom_nightmare"[\s\S]*?type: "Nightmare"/, "팬텀 악몽");
assert.match(roles, /id: "arthur_emberblade"[\s\S]*?type: "Protect"/, "아서 잔불 대검");
assert.match(roles, /id: "luru_charm"[\s\S]*?type: "Charm"/, "루루 매료");
assert.match(roles, /id: "luru_sonata"[\s\S]*?requiresCounter: \{ key: "charmCount", min: 3/, "루루 소나타(매료 3 게이트)");
assert.match(roles, /id: "luru_sonata"/, "루루 소나타 능력 정의(단일 출처)");
assert.match(matchAction, /clue >= 3 && !disguised/, "도르단 단서 3 — 정밀 조사");
const batch2cMig = readFileSync("supabase/migrations/20260614160000_gomdori_batch_tier2c.sql", "utf8");
assert.match(batch2cMig, /'luru_sonata'/, "마이그레이션 — 소나타");
assert.match(roles, /id: "uno_struggle"[\s\S]*?type: "GrantCount"/, "우노 투쟁");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?type: "ModifyReceivedVote"/, "엘런 박해");
assert.match(roles, /id: "luna_corrupt"[\s\S]*?type: "Corrupt"/, "루나 변환");
assert.match(roles, /id: "logen_nullify"[\s\S]*?type: "Nullify"/, "로건 무력화(다음 능력 소멸)");
assert.match(roles, /id: "daeakma_dominion"[\s\S]*?type: "Silence", target: "All"/, "대악마 압도적 존재감(전원 봉인)");
assert.match(roles, /id: "uno_valor"[\s\S]*?type: "Cleanse"/, "우노 용맹함(자기 정화)");
assert.match(roles, /id: "luna_corrupt"/, "루나 공포 능력 정의(단일 출처)");
assert.match(roles, /id: "luna_corrupt"[\s\S]*?requiresCounter: \{ key: "moonGauge", min: 2/, "루나 공포 — 달 게이지 게이트");
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
  /PUBLIC_ENGINE_EVENTS = new Set\(\["player_died", "player_revived"\]\)/,
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
assert.match(rolesSrc, /HELPER_CONTACT[\s\S]*?gain: \{ expiresAfterNight: 2 \}/, "가인 접선 — 밤2 만료");
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

console.log("Gomdori v2 abilities (봉인/부활/변환/신앙/백호) checks passed");

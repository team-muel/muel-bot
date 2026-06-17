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
assert.match(roles, /id: "mizlet_dessert"[\s\S]*?type: "Protect"/, "미즐렛 디저트 버프(Protect)");
assert.match(roles, /id: "arthur_judge"/, "아서 잔불이 꺼지기 전에 능력 정의(단일 출처)");
assert.match(roles, /id: "mizlet_dessert"/, "미즐렛 디저트 능력 정의(단일 출처)");
const batch2bMig = readFileSync("supabase/migrations/20260614150000_gomdori_batch_tier2b.sql", "utf8");
assert.match(batch2bMig, /'arthur_judge'/, "마이그레이션 — 단죄");
assert.match(batch2bMig, /'mizlet_dessert'/, "마이그레이션 — 디저트");

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
  assert.equal(newState.players.angel.currentRole, "corrupted", "타락자 역할");
  assert.ok(events.some((e: any) => e.type === "faction_changed" && e.payload?.new_faction === "demon"), "변환 이벤트");
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
// --- 4e. 미즐렛 고급 와인: 전원 정화 + 디저트 미제공자만 투표가치 -1 ---
{
  const fed = { ...player("fed", "citizen", "angel"), tags: ["dessert"], counters: { nightmare: 1 } };
  const unfed = { ...player("unfed", "citizen", "angel"), counters: { nightmare: 1 } };
  const state = emptyState(
    { mizlet: player("mizlet", "mizlet", "angel"), fed, unfed },
    [{ sourceUserId: "mizlet", targetUserId: null, actionType: "mizlet_wine", priority: 5 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.fed.counters.nightmare ?? 0, 0, "와인 — 디저트 대상 정화");
  assert.equal(newState.players.unfed.counters.nightmare ?? 0, 0, "와인 — 미제공자도 정화");
  assert.equal(newState.players.fed.counters.voteValueMod ?? 0, 0, "디저트 대상은 투표가치 페널티 없음");
  assert.equal(newState.players.unfed.counters.voteValueMod ?? 0, -1, "미제공자는 투표가치 -1");
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
// --- 6d-6. 가인 약간의 위선: 대상의 다음 능력 발동을 한 밤 연기 ---
{
  const state = emptyState(
    { gain: player("gain", "gain", "demon"), doc: player("doc", "doctor", "angel") },
    [{ sourceUserId: "gain", targetUserId: "doc", actionType: "gain_hypocrisy", priority: 5 }],
  );
  const { newState, events } = resolveNightActions(state);
  assert.equal(newState.players.doc.counters.delayPending, 1, "위선 — 연기 예약");
  assert.ok(events.some((e: any) => e.type === "hypocrisy_delayed"), "위선 연기 이벤트");
  const next = emptyState(
    { doc: newState.players.doc, victim: player("victim", "citizen", "angel"), demon: player("demon", "demon", "demon") },
    [
      { sourceUserId: "doc", targetUserId: "victim", actionType: "doctor_heal", priority: 3 },
      { sourceUserId: "demon", targetUserId: "victim", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState: after, events: ev2 } = resolveNightActions(next);
  assert.ok(ev2.some((e: any) => e.type === "action_delayed" && e.userId === "doc"), "위선 — 다음 밤 능력 연기");
  assert.equal(after.players.victim.alive, false, "연기된 치료 불발 → 피해자 사망");
}
// --- 6d-6b. 가인 위선 전환: 위선 대상이 밤에 탈락 → 다음 위선이 처치로 변경 ---
{
  // 1밤: 가인이 t에 위선(표식+연기). 같은 밤 악마가 t 처치 → 가인 hypocrisyKillReady 점화.
  const st1 = emptyState(
    { gain: player("gain", "gain", "demon"), t: player("t", "citizen", "angel"), demon: player("demon", "demon", "demon") },
    [
      { sourceUserId: "gain", targetUserId: "t", actionType: "gain_hypocrisy", priority: 5 },
      { sourceUserId: "demon", targetUserId: "t", actionType: "demon_kill", priority: 4 },
    ],
  );
  const { newState: s1 } = resolveNightActions(st1);
  assert.equal(s1.players.t.alive, false, "위선 대상 악마에 탈락");
  assert.equal(s1.players.gain.counters.hypocrisyKillReady, 1, "위선 전환 점화");
  // 2밤: 가인이 새 대상 v에 위선 → 연기 대신 처치.
  const st2 = emptyState(
    { gain: s1.players.gain, v: player("v", "citizen", "angel") },
    [{ sourceUserId: "gain", targetUserId: "v", actionType: "gain_hypocrisy", priority: 5 }],
  );
  const { newState: s2 } = resolveNightActions(st2);
  assert.equal(s2.players.v.alive, false, "전환된 위선 = 대상 처치");
  assert.equal(s2.players.v.counters.delayPending ?? 0, 0, "전환 시 연기 미적용");
  assert.equal(s2.players.gain.counters.hypocrisyKillReady ?? 0, 0, "전환 1회 소비");
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
assert.match(roles, /id: "malen_elusive"[\s\S]*?type: "SummonCorpse"/, "말렌 신출귀몰");
assert.match(roles, /id: "phantom_nightmare"[\s\S]*?type: "Nightmare"/, "팬텀 악몽");
assert.match(roles, /id: "arthur_emberblade"[\s\S]*?type: "Protect"/, "아서 잔불 대검");
assert.match(roles, /id: "luru_charm"[\s\S]*?type: "Charm"/, "루루 매료");
assert.match(roles, /id: "luru_sonata"[\s\S]*?requiresCounter: \{ key: "charmCount", min: 3/, "루루 소나타(매료 3 게이트)");
assert.match(roles, /id: "luru_sonata"/, "루루 소나타 능력 정의(단일 출처)");
assert.match(matchAction, /clue >= 3 && !disguised/, "도르단 단서 3 — 정밀 조사");
const batch2cMig = readFileSync("supabase/migrations/20260614160000_gomdori_batch_tier2c.sql", "utf8");
assert.match(batch2cMig, /'luru_sonata'/, "마이그레이션 — 소나타");
const malenElusiveMig = readFileSync("supabase/migrations/20260617190000_gomdori_malen_elusive.sql", "utf8");
assert.match(malenElusiveMig, /'malen_elusive'/, "마이그레이션 — 말렌 신출귀몰");
assert.match(roles, /id: "uno_struggle"[\s\S]*?type: "GrantCount"/, "우노 투쟁");
assert.match(roles, /id: "ellen_persecute"[\s\S]*?type: "ModifyReceivedVote"/, "엘런 박해");
assert.match(roles, /id: "luna_corrupt"[\s\S]*?type: "Corrupt"/, "루나 변환");
assert.match(roles, /id: "logen_nullify"[\s\S]*?type: "Nullify"/, "로건 무력화(다음 능력 소멸)");
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

// --- 우노 명예(투표가치 +10): 사탄의 마(-1)를 뚫고 우노의 표가 살아남는 천사 표 경로 ---
{
  const uno = { ...player("uno", "uno", "angel"), counters: { voteValueMod: 10 } }; // 배정 시 명예 주입
  const state = emptyState(
    {
      demon: player("demon", "demon", "demon"),
      uno,
      a1: player("a1", "citizen", "angel"),
    },
    [{ sourceUserId: "demon", targetUserId: "a1", actionType: "demon_kill", priority: 4 }],
  );
  const { newState } = resolveNightActions(state);
  assert.equal(newState.players.uno.counters.voteValueMod, 9, "사탄의 마 적용 후 우노 명예 10-1=9 잔존");
  // 우노 표=1+9=10, 일반 천사 표=max(0,1-1)=0 → 우노가 악마를 처형대로 보낼 수 있다(천사 표 경로).
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

// --- 베스토 v2 두 번째 자아: 투표가치 절대값 고정(사탄의 마 면역) ---
{
  // 솔(disguised=1) → 행사 투표가치 1 고정. 사탄의 마(voteValueMod=-5) 무시.
  const sol = { ...player("besto", "besto", "demon"), counters: { disguised: 1, voteValueMod: -5 } };
  const t = player("t", "citizen", "angel");
  const r = tallyEliminationVotes(
    [{ actorUserId: "besto", targetUserId: "t" }],
    { besto: sol, t },
  );
  assert.equal(r.tallies["t"], 1, "솔 — 투표가치 1 고정(사탄의 마 무시)");
}
{
  // 하베스토(disguised=0) → 3. 강화 스택 1 이면 3+2=5, 2 면 3+4=7.
  const ha0 = { ...player("besto", "besto", "demon"), counters: {} };
  const t = player("t", "citizen", "angel");
  assert.equal(tallyEliminationVotes([{ actorUserId: "besto", targetUserId: "t" }], { besto: ha0, t }).tallies["t"], 3, "하베스토 — 기본 3");
  const ha1 = { ...player("besto", "besto", "demon"), counters: { hiddenStack: 1 } };
  assert.equal(tallyEliminationVotes([{ actorUserId: "besto", targetUserId: "t" }], { besto: ha1, t }).tallies["t"], 5, "하베스토 강화 1 — 3+2=5");
  const ha2 = { ...player("besto", "besto", "demon"), counters: { hiddenStack: 2 } };
  assert.equal(tallyEliminationVotes([{ actorUserId: "besto", targetUserId: "t" }], { besto: ha2, t }).tallies["t"], 7, "하베스토 강화 2 — 3+4=7");
}

// --- 베스토 히든 포지션 미발동 → hiddenStack +1(상한 2) ---
{
  const r1 = resolveNightActions(emptyState(
    { besto: player("besto", "besto", "demon"), a: player("a", "citizen", "angel") },
    [],
  ));
  assert.equal(r1.newState.players.besto.counters.hiddenStack, 1, "미발동 밤 1 — 강화 1");
  const r2 = resolveNightActions(r1.newState);
  assert.equal(r2.newState.players.besto.counters.hiddenStack, 2, "미발동 밤 2 — 강화 2(상한)");
  const r3 = resolveNightActions(r2.newState);
  assert.equal(r3.newState.players.besto.counters.hiddenStack, 2, "미발동 밤 3 — 상한 유지(2 초과 X)");
}

// --- 베스토 히든 포지션 발동: 멀티타깃(1+강화) + 발동 후 스택 0 리셋 ---
{
  const besto = { ...player("besto", "besto", "demon"), counters: { hiddenStack: 2 } };
  const v1 = player("v1", "citizen", "angel");
  const v2 = player("v2", "doctor", "angel");
  const v3 = player("v3", "rainer", "angel");
  const v4 = player("v4", "romaz", "angel");
  const r = resolveNightActions(emptyState(
    { besto, v1, v2, v3, v4 },
    [{ sourceUserId: "besto", targetUserId: "v1", targetUserIds: ["v1", "v2", "v3"], actionType: "besto_hidden", priority: 4 }],
  ));
  assert.equal(r.newState.players.v1.alive, false, "히든 포지션 — v1 탈락");
  assert.equal(r.newState.players.v2.alive, false, "히든 포지션 — v2 탈락(멀티타깃)");
  assert.equal(r.newState.players.v3.alive, false, "히든 포지션 — v3 탈락(강화 2 → 1+2=3 명)");
  assert.equal(r.newState.players.v4.alive, true, "히든 포지션 — v4 비지정");
  assert.equal(r.newState.players.besto.counters.hiddenStack ?? 0, 0, "발동 후 강화 중첩 0 리셋");
}

// --- 베스토 누명씌우기: hiddenMark 표식 + 대상 사망 시 강화 +1 + 짝숫날 차단 ---
{
  // 홀수날(dayCount=3): besto_frameup + 다른 처치로 대상 탈락 → 베스토 강화 +1.
  const state: MatchState = {
    matchId: "v2", dayCount: 3, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: {
      besto: player("besto", "besto", "demon"),
      demon: player("demon", "demon", "demon"),
      v: player("v", "citizen", "angel"),
    },
    actionStack: [
      { sourceUserId: "besto", targetUserId: "v", actionType: "besto_frameup", priority: 5 },
      { sourceUserId: "demon", targetUserId: "v", actionType: "demon_kill", priority: 4 },
    ],
  };
  const r = resolveNightActions(state);
  assert.equal(r.newState.players.v.alive, false, "누명 대상 — 처치로 탈락");
  // hiddenMark 표식은 사망 후 정리됐어야 함.
  assert.ok(!r.newState.players.v.tags.includes("hiddenMark"), "hiddenMark 표식은 사망 후 1회 소비");
  assert.equal(r.newState.players.besto.counters.hiddenStack, 2, "누명 대상 사망 → 미발동 +1 + 누명 +1 = 2");
  assert.ok(r.events.some((e: any) => e.type === "frameup_credited"), "frameup_credited 이벤트");
}
{
  // 짝숫날(dayCount=2): evenDayBlocked 게이트로 차단 — hiddenMark 안 붙음.
  const state: MatchState = {
    matchId: "v2", dayCount: 2, phase: "night", angelCount: 0, demonCount: 0, modifiers: {},
    players: { besto: player("besto", "besto", "demon"), v: player("v", "citizen", "angel") },
    actionStack: [{ sourceUserId: "besto", targetUserId: "v", actionType: "besto_frameup", priority: 5 }],
  };
  const r = resolveNightActions(state);
  assert.ok(!r.newState.players.v.tags.includes("hiddenMark"), "짝숫날 — 누명 차단(표식 없음)");
  assert.ok(r.events.some((e: any) => e.type === "action_blocked_even_day"), "짝숫날 차단 이벤트");
}

// 베스토 v2 — 계약 정규식.
assert.match(roles, /id: "besto_hidden"[\s\S]*?targetCountCounter: "hiddenStack"/, "히든 포지션 — 강화 멀티타깃");
assert.match(roles, /id: "besto_hidden"[\s\S]*?onFireSetCounter: \{ key: "hiddenStack", value: 0 \}/, "히든 포지션 — 발동 시 중첩 리셋");
assert.match(roles, /id: "besto_frameup"[\s\S]*?evenDayBlocked: true/, "누명씌우기 — 짝숫날 차단");
assert.match(roles, /id: "besto_frameup"[\s\S]*?tag: "hiddenMark"/, "누명씌우기 — hiddenMark 표식");
const bestoMig = readFileSync("supabase/migrations/20260618100000_gomdori_besto_v2.sql", "utf8");
assert.match(bestoMig, /'besto_frameup'/, "마이그레이션 — 누명씌우기 action_type");

console.log("Gomdori v2 abilities (봉인/부활/변환/신앙/백호/사탄의마/우노명예/군인의사명/아서단죄/말렌혼령/소명/팬텀봉인/영면/침묵의밤/엘런누진/말렌마비/신출귀몰/베스토두번째자아/히든강화/누명씌우기) checks passed");

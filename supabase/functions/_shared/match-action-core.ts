import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { conflict, badRequest, forbidden } from "./errors.ts";
import { getMatch } from "./game.ts";
import { CORE_ROLES, HELPER_ROLES, isDemonKillerRole } from "./engine/roles.ts";
import { effectiveTargetCount, getRoleDefinition } from "./engine/engine.ts";
import { GOMDORI_RULES } from "./gomdori-rules.ts";

// match-action 의 검증+기록 코어. 사람(match-action)과 AI(match-ai-act)가 같은 규칙을
// 통과하도록 단일화한다(ADR-005). actorUserId 만 다르고 로직은 동일.

// 유효 직업 (2026-06-12): 게임 내 변환(낙인 재배정·타락·전향)은 engine_state.currentRole 에
// 영속화된다. 모든 role 판정은 이 함수를 거친다.
export function effectiveRole(row: { role: string; engine_state?: Record<string, unknown> | null }): string {
  const cur = (row.engine_state as { currentRole?: unknown } | null)?.currentRole;
  return typeof cur === "string" ? cur : row.role;
}

// 검증 테이블은 단일 출처(CORE_ROLES)에서 도출한다(ADR-006 S1). 능력을 roles.ts 한 곳에
// 정의하면 match-action 검증이 자동으로 따라온다 — 과거 손유지 복제 테이블을 대체.
const ALL_NIGHT_ABILITIES = CORE_ROLES.flatMap((r) => r.actions.night ?? []);

// 부활 계열(SINGLE_DEAD) — 탈락자를 대상으로.
export const REVIVE_ACTIONS: string[] = ALL_NIGHT_ABILITIES
  .filter((a) => a.targetType === "SINGLE_DEAD")
  .map((a) => a.id);
// 대상 없이 발동(SELF/NONE/ALL) — 자기/무대상 행동.
export const SELF_ACTIONS: string[] = ALL_NIGHT_ABILITIES
  .filter((a) => a.targetType === "SELF" || a.targetType === "NONE" || a.targetType === "ALL")
  .map((a) => a.id);
// role → 그 직업이 쓸 수 있는 밤 액션 id 목록.
export const NIGHT_ACTIONS_BY_ROLE: Record<string, string[]> = Object.fromEntries(
  CORE_ROLES.map((r) => [r.id, (r.actions.night ?? []).map((a) => a.id)]),
);

export type SubmitActionParams = {
  matchId: string;
  actorUserId: string;
  targetUserId: string | null;
  // 멀티타깃 능력(아서 잔불이 꺼지기 전에=3명). targetCount>1 인 능력에서 사용. 단일 능력은
  // targetUserId 만 보내면 된다(하위호환). 제네릭 — 능력 정의의 targetCount 로만 분기, 직업 하드코딩 X.
  targetUserIds?: string[] | null;
  actionType: string;
};

// 사탄의 마 전역 판정(canon 대악마): 생존 천사팀(currentFaction='angel') 전원의 행사
// 투표가치가 0 이하면(사탄의 마 누적 -1 로 전원 무력화) 모든 조사가 '악마'로 판정된다.
// 우노 명예(voteValueMod +10)가 살아있으면 그 한 명이 양수라 트리거되지 않는다 — 천사
// 진영 식별의 마지막 보루. 행사가치 = 1(base) + bonusVoteValue + voteWeightBonus + voteValueMod
// (tally 와 동일식). 생존 천사 0명이면 게임 종료 임박 — 굳이 강제하지 않는다(false).
async function isAngelTeamVoteFullySuppressed(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, "mafia">,
  matchId: string,
): Promise<boolean> {
  const { data: rows } = await supabase
    .from("match_players")
    .select("faction, engine_state")
    .eq("match_id", matchId)
    .eq("alive", true);
  if (!rows) return false;
  const angels = rows.filter((r) => {
    const cf = (r.engine_state as { currentFaction?: string } | null)?.currentFaction;
    return (typeof cf === "string" ? cf : r.faction) === "angel";
  });
  if (angels.length === 0) return false;
  return angels.every((r) => {
    const es = (r.engine_state as { bonusVoteValue?: number; counters?: Record<string, number> } | null) ?? {};
    const c = es.counters ?? {};
    const v = 1 + (es.bonusVoteValue ?? 0) + (c.voteWeightBonus ?? 0) + (c.voteValueMod ?? 0);
    return v <= 0;
  });
}

// 사탄의 마 per-target 판정(canon 대악마 "이 -1 효과로 *그 대상* 투표가치가 0이 되면 그 대상의
// 조사·취급이 악마로 판정"): 전역(전원 0) 판정과 별개로, *조사 대상 개인*의 행사 투표가치가
// 0 이하면 그 한 명은 악마로 판정한다. 전역 경로의 strict superset — 전원 0 이 아니어도 개별
// 적용. 행사가치 = 1(base) + bonusVoteValue + voteWeightBonus + voteValueMod(engine tally 동일식).
function isTargetVoteSuppressed(
  engineState: { bonusVoteValue?: number; counters?: Record<string, number> } | null,
): boolean {
  const es = engineState ?? {};
  const c = es.counters ?? {};
  const v = 1 + (es.bonusVoteValue ?? 0) + (c.voteWeightBonus ?? 0) + (c.voteValueMod ?? 0);
  return v <= 0;
}

/**
 * 한 플레이어의 행동을 검증하고 match_actions 에 기록한다(사람·AI 공용).
 * 검증 실패 시 GameError 를 throw. police_investigate 는 즉시 결과를 계산해 반환.
 */
export async function submitMatchAction(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, "mafia">,
  { matchId, actorUserId, actionType, targetUserId, targetUserIds }: SubmitActionParams,
): Promise<{ investigationResult: string | null }> {
  const match = await getMatch(matchId);

  const { data: currentPhase, error: phaseError } = await supabase
    .from("match_phases")
    .select("*")
    .eq("match_id", matchId)
    .is("ended_at", null)
    .order("phase_number", { ascending: false })
    .limit(1)
    .single();

  if (phaseError || !currentPhase) {
    throw conflict("no_active_phase", "현재 활성화된 페이즈가 없습니다.");
  }

  const { data: player, error: playerError } = await supabase
    .from("match_players")
    .select("role, alive, engine_state")
    .eq("match_id", matchId)
    .eq("user_id", actorUserId)
    .single();

  if (playerError || !player) throw forbidden("not_participant", "게임 참가자가 아닙니다.");
  if (!player.alive) throw forbidden("dead_player", "사망한 플레이어는 행동할 수 없습니다.");

  if (match.status === "night") {
    // 첫 밤 silent (vault canon §34): phase_number===1 + firstNight.skipsAbilities 면
    // 모든 능력 제출 차단. 정보 누적 전 첫 능력으로 결판나는 것 방지.
    if (currentPhase.phase_number === 1 && GOMDORI_RULES.firstNight.skipsAbilities) {
      throw conflict("first_night_silent", "첫 밤은 모두가 잠듭니다. 아침을 기다리세요.");
    }
    const actorRole = effectiveRole(player);
    // 단일 출처(CORE_ROLES): 허용 액션·대상 규칙을 능력 정의에서 직접 도출(ADR-006 S1).
    const ability = getRoleDefinition(actorRole)?.actions.night?.find((a) => a.id === actionType);
    if (!ability) {
      throw forbidden("invalid_role", "현재 직업으로는 이 밤 행동을 사용할 수 없습니다.");
    }
    if (ability.maxUses != null) {
      const counters = (player.engine_state as { counters?: Record<string, number> } | null)?.counters;
      if ((counters?.[`used_${actionType}`] ?? 0) >= ability.maxUses) {
        throw conflict("ability_exhausted", "이미 사용한 능력입니다.");
      }
    }
    if (actionType === "pasua_convert") {
      const counters = (player.engine_state as { counters?: Record<string, number> } | null)?.counters;
      if ((counters?.convertCooldown ?? 0) > 0) {
        throw conflict("convert_cooldown", "연속으로 포교할 수 없습니다. 다음 밤에 다시 시도하세요.");
      }
    }
    // 대상 없이 발동(SELF/NONE/ALL)이면 대상 검증 생략.
    const requiresNoTarget =
      ability.targetType === "SELF" || ability.targetType === "NONE" || ability.targetType === "ALL";
    if (!requiresNoTarget) {
      // 멀티타깃(아서 잔불이 꺼지기 전에=3명): 능력 정의의 targetCount 로만 분기(직업 하드코딩 X).
      // 단일 능력은 targetUserId, 멀티는 targetUserIds. 둘 다 한 검증 루프로 처리한다.
      // 동적 멀티타깃(팬텀 어둠이 내린 도시 = 2 + sealCap). engine 과 같은 식으로 상한 계산.
      const sourceCounters = (player.engine_state as { counters?: Record<string, number> } | null)?.counters ?? {};
      const maxTargets = effectiveTargetCount(ability, { counters: sourceCounters }, currentPhase.phase_number);
      const targets = (targetUserIds && targetUserIds.length)
        ? targetUserIds
        : (targetUserId ? [targetUserId] : []);
      if (targets.length === 0) throw badRequest("missing_target", "대상을 선택해야 합니다.");
      if (targets.length > maxTargets) throw badRequest("too_many_targets", `대상은 최대 ${maxTargets}명까지 지정할 수 있습니다.`);
      if (new Set(targets).size !== targets.length) throw badRequest("duplicate_target", "같은 대상을 중복으로 지정할 수 없습니다.");
      // 연속 지목 금지(팬텀 어둠이 내린 도시): 직전 같은 능력 제출의 대상과 겹치면 거부.
      if (ability.noConsecutiveTarget) {
        const { data: prior } = await supabase
          .from("match_actions")
          .select("target_user_id, result, phase_id, submitted_at")
          .eq("match_id", matchId)
          .eq("actor_user_id", actorUserId)
          .eq("action_type", actionType)
          .neq("phase_id", currentPhase.id)
          .order("submitted_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (prior) {
          const priorTargets = new Set<string>();
          if (prior.target_user_id) priorTargets.add(prior.target_user_id as string);
          const pr = prior.result as { targetUserIds?: string[] } | null;
          for (const t of pr?.targetUserIds ?? []) priorTargets.add(t);
          if (targets.some((t) => priorTargets.has(t))) {
            throw badRequest("consecutive_target", "같은 대상을 연속으로 지목할 수 없습니다. 다른 대상을 고르세요.");
          }
        }
      }
      for (const tId of targets) {
        if (ability.excludeSelf && tId === actorUserId) {
          throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
        }
        const { data: targetState } = await supabase
          .from("match_players")
          .select("alive, role, faction, engine_state, eliminated_phase_number")
          .eq("match_id", matchId)
          .eq("user_id", tId)
          .single();
        if (!targetState) throw badRequest("invalid_target", "대상을 찾을 수 없습니다.");
        const targetRole = effectiveRole(targetState);
        const targetTags = ((targetState.engine_state as { tags?: string[] } | null)?.tags ?? []);
        const allowRememberedDead = ability.allowRememberedDead && targetTags.includes("remembered");
        if (ability.targetType === "SINGLE_DEAD") {
          if (targetState.alive) throw badRequest("invalid_target", "부활은 탈락한 대상에게만 사용할 수 있습니다.");
          // 부활 딜레이(canon 미즐렛 — 즉시 복귀가 아니라 예측 가능한 메커니즘): 탈락 직후
          // 다음 밤 즉시 부활을 막는다. 탈락 시점(eliminated_phase_number)으로부터 2일차 이상
          // 지나야 부활 가능 — "1일차에 죽고 2일차에 부활" 방지.
          const deathPhase = (targetState as { eliminated_phase_number?: number | null }).eliminated_phase_number ?? null;
          if (deathPhase != null && currentPhase.phase_number - deathPhase < 2) {
            throw conflict("revive_too_soon", "최근에 탈락한 대상은 아직 되살릴 수 없습니다. 며칠 지나야 합니다.");
          }
        } else if (!targetState.alive && !allowRememberedDead) {
          throw badRequest("dead_target", "이미 사망한 대상은 선택할 수 없습니다.");
        }
        // 대상 직업/진영 제한(ADR-006 S2): 능력 선언(targetFilter)에서 제네릭 평가.
        // 과거 파스아·루나 하드코딩 if-블록을 대체. 엔진 applyEffect 도 이중 가드.
        const tf = ability.targetFilter;
        if (tf) {
          const targetFaction =
            (targetState.engine_state as { currentFaction?: string } | null)?.currentFaction ??
            (typeof targetState.faction === "string" ? targetState.faction : null);
          const blocked =
            (tf.excludeRoleSets?.includes("demonKiller") && isDemonKillerRole(targetRole)) ||
            (tf.excludeRoleSets?.includes("helper") && HELPER_ROLES.includes(targetRole)) ||
            (tf.excludeRoles?.includes(targetRole)) ||
            (targetFaction != null && tf.excludeFactions?.includes(targetFaction as never));
          if (blocked) {
            throw badRequest("invalid_target", tf.message ?? "그 대상에게는 사용할 수 없습니다.");
          }
        }
      }
    }
  } else if (
    (match.status === "day" || match.status === "vote" || match.status === "verdict") &&
    getRoleDefinition(effectiveRole(player))?.actions.night?.find((a) => a.id === actionType)?.usableInDay
  ) {
    // 영면 낮 발동(팬텀): 쌓아둔 영면(deepsleep) 전원 즉시 처치 + 팬텀 deepsleepCount 리셋. 처형
    // 시간에 다수를 한 번에 정리하는 canon. 밤 제출은 엔진 경로(여긴 낮 전용 즉시 처리, 조기 return).
    const pooled = (await supabase
      .from("match_players")
      .select("user_id, engine_state")
      .eq("match_id", matchId)
      .eq("alive", true)).data ?? [];
    const nowIso = new Date().toISOString();
    let reaped = 0;
    for (const pp of pooled as Array<{ user_id: string; engine_state: Record<string, unknown> | null }>) {
      const dc = (pp.engine_state as { counters?: { deepsleep?: number } } | null)?.counters?.deepsleep ?? 0;
      if (dc > 0) {
        await supabase.from("match_players")
          .update({ alive: false, eliminated_at: nowIso, eliminated_phase_number: currentPhase.phase_number, eliminated_cause: "deepsleep" })
          .eq("match_id", matchId).eq("user_id", pp.user_id);
        await supabase.from("match_events")
          .insert({ match_id: matchId, phase_id: currentPhase.id, event_type: "player_died", visibility: "public", payload: { user_id: pp.user_id, source: "phantom_reap_day" } });
        reaped++;
      }
    }
    const pes = (player.engine_state ?? {}) as Record<string, unknown>;
    await supabase.from("match_players")
      .update({ engine_state: { ...pes, counters: { ...((pes.counters as Record<string, number>) ?? {}), deepsleepCount: 0 } } })
      .eq("match_id", matchId).eq("user_id", actorUserId);
    await supabase.from("match_events")
      .insert({ match_id: matchId, phase_id: currentPhase.id, event_type: "deepsleep_reaped", visibility: "public", payload: { user_id: actorUserId, count: reaped } });
    return { investigationResult: null };
  } else if (match.status === "vote") {
    if (actionType !== "vote") throw badRequest("invalid_phase", "현재는 투표 페이즈입니다.");
  } else if (match.status === "verdict") {
    if (actionType !== "verdict_approve" && actionType !== "verdict_reject") {
      throw badRequest("invalid_phase", "현재는 찬반 투표 페이즈입니다.");
    }
  } else if (match.status === "night_suspect") {
    if (actionType !== "suspect") throw badRequest("invalid_phase", "현재는 의심 투표 페이즈입니다.");
  } else {
    throw conflict("invalid_phase", "지금은 행동을 할 수 없는 페이즈입니다.");
  }

  // 약간의 위선(가인): 대상 진영 통지(악마팀 정찰). 정밀조사/전역판정/사건의전말 없이 기본 판정만.
  let investigationResult: string | null = null;
  if (actionType === "gain_hypocrisy" && targetUserId) {
    const { data: target } = await supabase
      .from("match_players")
      .select("role, engine_state")
      .eq("match_id", matchId)
      .eq("user_id", targetUserId)
      .single();
    if (target) {
      const disguised = ((target.engine_state as { counters?: { disguised?: number } } | null)?.counters?.disguised ?? 0) > 0;
      // 사탄의 마 per-target: 대상 본인 투표가치가 0 이하로 꺼졌으면 악마로 판정(전역 0 불필요).
      if (isTargetVoteSuppressed(target.engine_state as { bonusVoteValue?: number; counters?: Record<string, number> } | null)) {
        investigationResult = "demon";
      } else {
        investigationResult = (isDemonKillerRole(effectiveRole(target)) && !disguised) ? "demon" : "angel";
      }
    }
  }

  // 용의자 색출(로마즈): 조사장(clueWarrant) 보유(≥1) 시 색출이 "용의자가 악마인지 통지" 효과를
  // 더한다(원문 [천사]2). police 와 같은 판정 경로 — 사탄의 마 per-target/전역 우선, 변신·정밀조사
  // 미적용(로마즈는 정밀조사 풀 아님). 조사장은 발동 후 GrantCount 로 +1(이번 색출 효과는 직전까지
  // 누적분 기준이므로 제출 시점의 clueWarrant 로 통지 여부를 가른다 — 첫 색출은 통지 X, 이후 통지 O).
  if (actionType === "romaz_suspect" && targetUserId) {
    const warrants = (player.engine_state as { counters?: { clueWarrant?: number } } | null)?.counters?.clueWarrant ?? 0;
    if (warrants >= 1) {
      const { data: target } = await supabase
        .from("match_players")
        .select("role, engine_state")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();
      if (target) {
        const disguised = ((target.engine_state as { counters?: { disguised?: number } } | null)?.counters?.disguised ?? 0) > 0;
        if (await isAngelTeamVoteFullySuppressed(supabase, matchId)) {
          investigationResult = "demon";
        } else if (isTargetVoteSuppressed(target.engine_state as { bonusVoteValue?: number; counters?: Record<string, number> } | null)) {
          investigationResult = "demon";
        } else {
          investigationResult = (isDemonKillerRole(effectiveRole(target)) && !disguised) ? "demon" : "angel";
        }
      }
    }
  }

  // police 조사 즉시 결과
  if (actionType === "police_investigate" && targetUserId) {
    const { data: target } = await supabase
      .from("match_players")
      .select("role, engine_state")
      .eq("match_id", matchId)
      .eq("user_id", targetUserId)
      .single();

    if (target) {
      const disguised = ((target.engine_state as { counters?: { disguised?: number } } | null)?.counters?.disguised ?? 0) > 0;
      const clue = (player.engine_state as { counters?: { clue?: number } } | null)?.counters?.clue ?? 0;
      // 사탄의 마 전역 판정 우선(천사팀 전원 투표가치 0 → 모든 조사가 '악마', 변신·정밀조사 무시).
      // per-target(canon): 전원이 아니어도 *그 대상* 투표가치가 0 이하면 그 한 명은 악마로 판정.
      if (await isAngelTeamVoteFullySuppressed(supabase, matchId)) {
        investigationResult = "demon";
      } else if (isTargetVoteSuppressed(target.engine_state as { bonusVoteValue?: number; counters?: Record<string, number> } | null)) {
        investigationResult = "demon";
      } else if (clue >= 3 && !disguised) {
        investigationResult = effectiveRole(target);
      } else {
        investigationResult = (isDemonKillerRole(effectiveRole(target)) && !disguised) ? "demon" : "angel";
      }

      // 사건의 전말(도르단): 정밀 조사(clue≥3)로 악마 처치자를 정확히 식별하면 다음 아침을
      // 생략하고 그 악마를 곧장 판결대에 세운다. matches.engine_state.caseClosed 에 기록 →
      // phase-advance(night_resolve)가 읽어 verdict 를 강제(전원 통지·아침 생략·판결). canon §도르단.
      if (effectiveRole(player) === "dordan" && clue >= 3 && !disguised && isDemonKillerRole(effectiveRole(target))) {
        const { data: m } = await supabase.from("matches").select("engine_state").eq("id", matchId).single();
        const es = ((m?.engine_state ?? {}) as Record<string, unknown>);
        await supabase
          .from("matches")
          .update({ engine_state: { ...es, caseClosed: { demonUserId: targetUserId, byUserId: actorUserId } } })
          .eq("id", matchId);
      }
    }
  }

  if (actionType === "verdict_approve" || actionType === "verdict_reject") {
    const { error: clearVerdictError } = await supabase
      .from("match_actions")
      .delete()
      .eq("phase_id", currentPhase.id)
      .eq("actor_user_id", actorUserId)
      .in("action_type", ["verdict_approve", "verdict_reject"]);
    if (clearVerdictError) throw clearVerdictError;
  }

  // 멀티타깃은 (phase_id,actor,action_type) 유니크 제약상 한 행에 담는다 — 대표 대상은 첫 번째,
  // 전체 목록은 result.targetUserIds(JSON)에 저장. phase-advance 가 이 목록을 actionStack 으로 복원.
  const primaryTarget = (targetUserIds && targetUserIds.length) ? targetUserIds[0] : targetUserId;
  const resultPayload: Record<string, unknown> = {};
  if (investigationResult) resultPayload.investigationResult = investigationResult;
  if (targetUserIds && targetUserIds.length > 1) resultPayload.targetUserIds = targetUserIds;

  const { error: actionError } = await supabase
    .from("match_actions")
    .upsert({
      phase_id: currentPhase.id,
      match_id: matchId,
      actor_user_id: actorUserId,
      action_type: actionType,
      target_user_id: primaryTarget,
      result: Object.keys(resultPayload).length ? resultPayload : null,
      submitted_at: new Date().toISOString(),
    }, { onConflict: "phase_id, actor_user_id, action_type" });

  if (actionError) throw actionError;

  return { investigationResult };
}

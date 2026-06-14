import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { conflict, badRequest, forbidden } from "./errors.ts";
import { getMatch } from "./game.ts";
import { CORE_ROLES, HELPER_ROLES, isDemonKillerRole } from "./engine/roles.ts";
import { getRoleDefinition } from "./engine/engine.ts";

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
  actionType: string;
  targetUserId: string | null;
};

/**
 * 한 플레이어의 행동을 검증하고 match_actions 에 기록한다(사람·AI 공용).
 * 검증 실패 시 GameError 를 throw. police_investigate 는 즉시 결과를 계산해 반환.
 */
export async function submitMatchAction(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, "mafia">,
  { matchId, actorUserId, actionType, targetUserId }: SubmitActionParams,
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
    if (currentPhase.phase_number === 1) {
      throw conflict("first_night", "첫 번째 밤에는 능력을 사용할 수 없습니다.");
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
      if (!targetUserId) throw badRequest("missing_target", "대상을 선택해야 합니다.");
      if (ability.excludeSelf && targetUserId === actorUserId) {
        throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
      }
      const { data: targetState } = await supabase
        .from("match_players")
        .select("alive, role, engine_state")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();
      if (!targetState) throw badRequest("invalid_target", "대상을 찾을 수 없습니다.");
      const targetRole = effectiveRole(targetState);
      if (ability.targetType === "SINGLE_DEAD") {
        if (targetState.alive) throw badRequest("invalid_target", "부활은 탈락한 대상에게만 사용할 수 있습니다.");
      } else if (!targetState.alive) {
        throw badRequest("dead_target", "이미 사망한 대상은 선택할 수 없습니다.");
      }
      if (
        actionType === "pasua_convert" &&
        (isDemonKillerRole(targetRole) || targetRole === "pasua" || targetRole === "converted")
      ) {
        throw badRequest("invalid_target", "악마와 중립은 포교할 수 없습니다.");
      }
      if (
        actionType === "luna_corrupt" &&
        (isDemonKillerRole(targetRole) ||
          HELPER_ROLES.includes(targetRole) ||
          ["pasua", "converted", "corrupted"].includes(targetRole))
      ) {
        throw badRequest("invalid_target", "천사만 타락시킬 수 있습니다.");
      }
    }
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

  // police 조사 즉시 결과
  let investigationResult: string | null = null;
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
      if (clue >= 3 && !disguised) {
        investigationResult = effectiveRole(target);
      } else {
        investigationResult = (isDemonKillerRole(effectiveRole(target)) && !disguised) ? "demon" : "angel";
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

  const { error: actionError } = await supabase
    .from("match_actions")
    .upsert({
      phase_id: currentPhase.id,
      match_id: matchId,
      actor_user_id: actorUserId,
      action_type: actionType,
      target_user_id: targetUserId,
      result: investigationResult ? { investigationResult } : null,
      submitted_at: new Date().toISOString(),
    }, { onConflict: "phase_id, actor_user_id, action_type" });

  if (actionError) throw actionError;

  return { investigationResult };
}

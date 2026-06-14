import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { conflict, badRequest, forbidden } from "./errors.ts";
import { getMatch } from "./game.ts";
import { HELPER_ROLES, isDemonKillerRole } from "./engine/roles.ts";
import { getRoleDefinition } from "./engine/engine.ts";

// match-action 의 검증+기록 코어. 사람(match-action)과 AI(match-ai-act)가 같은 규칙을
// 통과하도록 단일화한다(ADR-005). actorUserId 만 다르고 로직은 동일.

// 유효 직업 (2026-06-12): 게임 내 변환(낙인 재배정·타락·전향)은 engine_state.currentRole 에
// 영속화된다. 모든 role 판정은 이 함수를 거친다.
export function effectiveRole(row: { role: string; engine_state?: Record<string, unknown> | null }): string {
  const cur = (row.engine_state as { currentRole?: unknown } | null)?.currentRole;
  return typeof cur === "string" ? cur : row.role;
}

// 부활 계열(SINGLE_DEAD) — 탈락자를 대상으로.
export const REVIVE_ACTIONS = ["mizlet_revive", "helen_revive"];
// 자기 대상(SELF) 행동 — 대상 없이 자기에게 발동.
export const SELF_ACTIONS = ["phantom_eclipse", "besto_shift", "rainer_summon", "luna_moonlight", "ellen_persecute", "uno_valor", "daeakma_dominion", "luru_sonata"];

export const NIGHT_ACTIONS_BY_ROLE: Record<string, string[]> = {
  // 악마 풀
  demon: ["demon_kill", "daeakma_brand", "daeakma_dominion"],
  phantom: ["phantom_nightmare", "phantom_seal", "phantom_eclipse"],
  malen: ["malen_release", "malen_possess"],
  besto: ["besto_hidden", "besto_shift"],
  // 천사 능동
  dordan: ["police_investigate"],
  habreterus: ["doctor_heal"],
  mizlet: ["mizlet_revive", "mizlet_dessert"],
  helen: ["helen_revive", "helen_sleep"],
  romaz: ["romaz_suspect"],
  rainer: ["rainer_summon"],
  seika: ["seika_supernova"],
  arthur: ["arthur_emberblade", "arthur_judge"],
  luru: ["luru_charm", "luru_sonata"],
  // 조력자 고유(v2)
  luna: ["luna_moonlight", "luna_corrupt"],
  logen: ["logen_nullify"],
  ellen: ["ellen_persecute"],
  uno: ["uno_struggle", "uno_valor"],
  // 중립
  pasua: ["pasua_convert", "pasua_faith"],
  // 레거시
  doctor: ["doctor_heal"],
  police: ["police_investigate"],
};

// 처치류(자기 자신 불가) — 대상 검증용.
const KILL_LIKE = ["demon_kill", "phantom_nightmare", "malen_release", "besto_hidden", "pasua_faith", "arthur_judge"];
const NO_SELF_TARGET = ["pasua_convert", "luna_corrupt", "logen_nullify", "ellen_persecute", "uno_struggle", "arthur_emberblade", "luru_charm", "malen_possess", "daeakma_brand"];

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
    const allowedActions = NIGHT_ACTIONS_BY_ROLE[actorRole] ?? [];
    if (!allowedActions.includes(actionType)) {
      throw forbidden("invalid_role", "현재 직업으로는 이 밤 행동을 사용할 수 없습니다.");
    }
    const ability = getRoleDefinition(actorRole)?.actions.night?.find((a) => a.id === actionType);
    if (ability?.maxUses != null) {
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
    if (!SELF_ACTIONS.includes(actionType)) {
      if (!targetUserId) throw badRequest("missing_target", "대상을 선택해야 합니다.");
      if (KILL_LIKE.includes(actionType) && targetUserId === actorUserId) {
        throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
      }
      if (NO_SELF_TARGET.includes(actionType) && targetUserId === actorUserId) {
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
      if (REVIVE_ACTIONS.includes(actionType)) {
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

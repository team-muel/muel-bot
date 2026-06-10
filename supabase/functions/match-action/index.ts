import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";
import { HELPER_ROLES, isDemonKillerRole } from "../_shared/engine/roles.ts";

// 부활 계열(SINGLE_DEAD) — 일반 밤 행동과 달리 *탈락자* 를 대상으로 한다.
const REVIVE_ACTIONS = ["mizlet_revive", "helen_revive"];

const NIGHT_ACTIONS_BY_ROLE: Record<string, string[]> = {
  // 악마 풀
  demon: ["demon_kill"],
  phantom: ["demon_kill", "phantom_seal"], // 처치 + 어둠이 내린 도시(봉인, v2)
  malen: ["demon_kill"],
  besto: ["demon_kill"],
  // 천사 능동
  dordan: ["police_investigate"], // 도르단 = 탐정 조사
  habreterus: ["doctor_heal"],
  mizlet: ["mizlet_revive"], // 디저트 선물 = 탈락자 부활(v2)
  helen: ["helen_revive"], // 황금빛 수면 = 탈락자 부활(v2)
  romaz: ["romaz_suspect"],
  seika: ["seika_supernova"], // 초신성 = 봉인(v2)
  arthur: ["arthur_emberblade"], // 잔불 대검 = 대상 하루 무적
  luru: ["luru_charm"], // 매료 = 처형 투표 양도
  // 조력자 고유(v2)
  luna: ["luna_corrupt"], // 천사 → 악마팀 변환
  logen: ["logen_nullify"], // 그 밤 대상 능력 무력화(봉인)
  ellen: ["ellen_persecute"], // 박해 — 받는-투표가치 누진
  uno: ["uno_struggle"], // 투쟁 — 대상 소속 카운트 +1
  // 중립
  pasua: ["pasua_convert"],
  // 레거시(현 로스터 미배정이나 정의는 유지)
  doctor: ["doctor_heal"],
  police: ["police_investigate"],
};

export function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw badRequest("invalid_field", `${key} must be a string.`);
  }
  return value.trim() || null;
}

Deno.serve((req: Request) => {
  return withErrorHandling(req, async () => {
    const origin = req.headers.get("Origin");
    const pre = preflight(req);
    if (pre) return pre;

    if (req.method !== "POST") {
      return jsonResponse(
        { error: { code: "method_not_allowed", message: "POST only." } },
        { status: 405, origin },
      );
    }

    const claims = await requireGameAuth(req);
    const body = readJsonObject(await req.json().catch(() => null));
    const matchId = readRequiredString(body, "matchId");
    const actionType = readRequiredString(body, "actionType"); // night actions, vote, verdict_approve, verdict_reject
    const targetUserId = readOptionalString(body, "targetUserId"); // Can be null for skip vote

    const supabase = getSupabaseAdmin();

    // 1. Get current match and phase
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

    // 2. Validate action against current phase and role
    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .select("role, alive")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .single();

    if (playerError || !player) throw forbidden("not_participant", "게임 참가자가 아닙니다.");
    if (!player.alive) throw forbidden("dead_player", "사망한 플레이어는 행동할 수 없습니다.");

    if (match.status === "night") {
      // H-1: first night skips all abilities (GOMDORI_RULES.firstNight.skipsAbilities);
      // phase-advance discards them anyway, so reject instead of silently accepting.
      if (currentPhase.phase_number === 1) {
        throw conflict("first_night", "첫 번째 밤에는 능력을 사용할 수 없습니다.");
      }
      const allowedActions = NIGHT_ACTIONS_BY_ROLE[player.role] ?? [];
      if (!allowedActions.includes(actionType)) {
        throw forbidden("invalid_role", "현재 직업으로는 이 밤 행동을 사용할 수 없습니다.");
      }
      if (!targetUserId) throw badRequest("missing_target", "대상을 선택해야 합니다.");
      // M-1: a demon cannot target itself.
      if (actionType === "demon_kill" && targetUserId === claims.sub) {
        throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
      }
      // 포교·변환·무력화·박해·투쟁·잔불대검·매료: 자기 자신 불가.
      if (
        ["pasua_convert", "luna_corrupt", "logen_nullify", "ellen_persecute", "uno_struggle", "arthur_emberblade", "luru_charm"].includes(actionType) &&
        targetUserId === claims.sub
      ) {
        throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
      }
      const { data: targetState } = await supabase
        .from("match_players")
        .select("alive, role")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();
      if (!targetState) throw badRequest("invalid_target", "대상을 찾을 수 없습니다.");
      if (REVIVE_ACTIONS.includes(actionType)) {
        // 부활(미즐렛/헬렌): 탈락한 대상에게만.
        if (targetState.alive) throw badRequest("invalid_target", "부활은 탈락한 대상에게만 사용할 수 있습니다.");
      } else if (!targetState.alive) {
        // H-4: 그 외 밤 행동은 생존자만 대상으로.
        throw badRequest("dead_target", "이미 사망한 대상은 선택할 수 없습니다.");
      }
      // 포교(파스아): 악마(처치자)·중립 포교 불가(canon §파스아). 가인 등 조력자·천사는 가능.
      // 처치자 집합으로 판정 — 가인/루나 등 조력자는 faction='demon' 이나 처치자가 아니라 허용.
      if (
        actionType === "pasua_convert" &&
        (isDemonKillerRole(targetState.role) || targetState.role === "pasua" || targetState.role === "converted")
      ) {
        throw badRequest("invalid_target", "악마와 중립은 포교할 수 없습니다.");
      }
      // 변환(루나): 천사만. 악마(처치자)·조력자·중립·이미 타락은 불가.
      if (
        actionType === "luna_corrupt" &&
        (isDemonKillerRole(targetState.role) ||
          HELPER_ROLES.includes(targetState.role) ||
          ["pasua", "converted", "corrupted"].includes(targetState.role))
      ) {
        throw badRequest("invalid_target", "천사만 타락시킬 수 있습니다.");
      }
    } else if (match.status === "vote") {
      if (actionType !== "vote") throw badRequest("invalid_phase", "현재는 투표 페이즈입니다.");
    } else if (match.status === "verdict") {
      if (actionType !== "verdict_approve" && actionType !== "verdict_reject") {
        throw badRequest("invalid_phase", "현재는 찬반 투표 페이즈입니다.");
      }
    } else if (match.status === "night_suspect") {
      // 의심 투표. 대상 null = 기권(무투, canon §3).
      if (actionType !== "suspect") throw badRequest("invalid_phase", "현재는 의심 투표 페이즈입니다.");
    } else {
      throw conflict("invalid_phase", "지금은 행동을 할 수 없는 페이즈입니다.");
    }

    // 3. Calculate instant result if police investigation
    let investigationResult = null;
    if (actionType === "police_investigate" && targetUserId) {
      const { data: target } = await supabase
        .from("match_players")
        .select("role")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();
      
      if (target) {
        // 처치자(악마 풀)만 '악마'로 보인다. 조력자(가인 등)·천사·중립은 '천사'(=악마 아님).
        investigationResult = isDemonKillerRole(target.role) ? "demon" : "angel";
      }
    }

    // Verdict choices use two action labels, so clear the opposite choice before
    // upsert to preserve one active verdict ballot per player.
    if (actionType === "verdict_approve" || actionType === "verdict_reject") {
      const { error: clearVerdictError } = await supabase
        .from("match_actions")
        .delete()
        .eq("phase_id", currentPhase.id)
        .eq("actor_user_id", claims.sub)
        .in("action_type", ["verdict_approve", "verdict_reject"]);

      if (clearVerdictError) throw clearVerdictError;
    }

    // 4. Insert or update action
    // Upsert so players can change their mind before the phase ends
    const { error: actionError } = await supabase
      .from("match_actions")
      .upsert({
        phase_id: currentPhase.id,
        match_id: matchId,
        actor_user_id: claims.sub,
        action_type: actionType,
        target_user_id: targetUserId,
        result: investigationResult ? { investigationResult } : null,
        submitted_at: new Date().toISOString()
      }, { onConflict: 'phase_id, actor_user_id, action_type' });

    if (actionError) throw actionError;

    return jsonResponse({ success: true, investigationResult }, { origin });
  });
});

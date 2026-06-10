import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

const NIGHT_ACTIONS_BY_ROLE: Record<string, string[]> = {
  demon: ["demon_kill"],
  doctor: ["doctor_heal"],
  police: ["police_investigate"],
  romaz: ["romaz_suspect"],
  pasua: ["pasua_convert"],
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
      // 포교(파스아): 자기 자신 불가.
      if (actionType === "pasua_convert" && targetUserId === claims.sub) {
        throw badRequest("invalid_target", "자기 자신을 포교할 수 없습니다.");
      }
      // H-4: night actions must target a living player.
      const { data: targetState } = await supabase
        .from("match_players")
        .select("alive, role")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();
      if (!targetState || !targetState.alive) {
        throw badRequest("dead_target", "이미 사망한 대상은 선택할 수 없습니다.");
      }
      // 포교(파스아): 악마·중립 포교 불가(canon §파스아). 가인(조력자)·천사는 가능.
      // role 로 판정 — 가인은 DB faction='demon' 이지만 role='gain' 이라 허용된다.
      if (
        actionType === "pasua_convert" &&
        (targetState.role === "demon" || targetState.role === "pasua" || targetState.role === "converted")
      ) {
        throw badRequest("invalid_target", "악마와 중립은 포교할 수 없습니다.");
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
        // Only the exact "demon" role shows up as demon. "helper" shows up as "angel" (not demon).
        investigationResult = target.role === "demon" ? "demon" : "angel";
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

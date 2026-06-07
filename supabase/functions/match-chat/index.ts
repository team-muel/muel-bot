import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

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
    const message = readRequiredString(body, "message");

    const supabase = getSupabaseAdmin();

    // 1. Get current match and phase
    const match = await getMatch(matchId);
    
    if (match.status !== "night") {
      throw badRequest("invalid_phase", "채팅은 밤에만 가능합니다.");
    }

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

    // 2. Validate role
    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .select("faction, alive")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .single();

    if (playerError || !player) throw forbidden("not_participant", "게임 참가자가 아닙니다.");
    if (!player.alive) throw forbidden("dead_player", "사망한 플레이어는 채팅할 수 없습니다.");
    
    if (player.faction !== "demon") {
      throw forbidden("invalid_role", "악마 진영만 야간 채팅을 사용할 수 있습니다.");
    }

    // 3. Insert chat message
    const { error: chatError } = await supabase
      .from("match_chats")
      .insert({
        match_id: matchId,
        phase_id: currentPhase.id,
        channel: "demon_circle",
        sender_user_id: claims.sub,
        message: message
      });

    if (chatError) throw chatError;

    return jsonResponse({ success: true }, { origin });
  });
});

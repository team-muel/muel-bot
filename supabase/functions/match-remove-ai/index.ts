import { preflight, jsonResponse } from "../_shared/cors.ts";
import { badRequest, conflict, forbidden, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { getMatch, readJsonObject, readRequiredString } from "../_shared/game.ts";

// match-remove-ai (ADR-005): 호스트가 로비에서 영입한 AI 용병을 내보낸다.
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
    const userId = readRequiredString(body, "userId");

    const match = await getMatch(matchId);
    if (match.status !== "lobby") {
      throw conflict("invalid_status", "로비 상태에서만 AI를 내보낼 수 있습니다.");
    }
    if (match.hostUserId !== claims.sub) {
      throw forbidden("not_host", "방장만 AI를 내보낼 수 있습니다.");
    }

    const supabase = getSupabaseAdmin();

    const { data: target, error: targetError } = await supabase
      .from("match_players")
      .select("user_id, is_ai")
      .eq("match_id", matchId)
      .eq("user_id", userId)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target || !target.is_ai) {
      throw badRequest("not_ai_player", "내보낼 수 있는 AI 참가자가 아닙니다.");
    }

    const { error: deleteError } = await supabase
      .from("match_players")
      .delete()
      .eq("match_id", matchId)
      .eq("user_id", userId);
    if (deleteError) throw deleteError;

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: "player_left",
      visibility: "public",
      payload: { userId, isAi: true },
    });
    if (eventError) throw eventError;

    return jsonResponse({ success: true }, { origin });
  });
});

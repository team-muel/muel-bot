import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, forbidden, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { getMatch, readJsonObject, readRequiredString } from "../_shared/game.ts";

// 방장이 로비에서 다른 참가자를 강퇴한다. 권위는 service-role DB 쓰기.
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
    const targetUserId = readRequiredString(body, "targetUserId");

    if (targetUserId === claims.sub) {
      throw conflict("cannot_kick_self", "자기 자신은 강퇴할 수 없습니다.");
    }

    const match = await getMatch(matchId);
    if (match.status !== "lobby") {
      throw conflict("not_lobby", "로비에서만 강퇴할 수 있습니다.");
    }

    const supabase = getSupabaseAdmin();

    const { data: caller, error: callerError } = await supabase
      .from("match_players")
      .select("is_host")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .maybeSingle();
    if (callerError) throw callerError;
    if (!caller?.is_host) throw forbidden("not_host", "방장만 강퇴할 수 있습니다.");

    const { error: deleteError } = await supabase
      .from("match_players")
      .delete()
      .eq("match_id", matchId)
      .eq("user_id", targetUserId);
    if (deleteError) throw deleteError;

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: "player_kicked",
      visibility: "public",
      payload: { userId: targetUserId, byUserId: claims.sub },
    });
    if (eventError) throw eventError;

    return jsonResponse({ success: true }, { origin });
  });
});

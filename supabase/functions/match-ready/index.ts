import { preflight, jsonResponse } from "../_shared/cors.ts";
import { badRequest, conflict, notFound, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  getMatch,
  readJsonObject,
  readRequiredString,
  toPlayerSummary,
} from "../_shared/game.ts";

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
    const ready = body.ready;
    if (typeof ready !== "boolean") {
      throw badRequest("missing_ready", "ready must be a boolean.");
    }

    const match = await getMatch(matchId);
    if (match.status !== "lobby") {
      throw conflict("match_not_in_lobby", "Ready can only be changed in the lobby.");
    }

    const supabase = getSupabaseAdmin();
    const { data: player, error: updateError } = await supabase
      .from("match_players")
      .update({ ready, last_seen_at: new Date().toISOString() })
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .select("*")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!player) throw notFound("player_not_found", "Join the match before setting ready.");

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: ready ? "player_ready" : "player_unready",
      visibility: "public",
      payload: { userId: claims.sub },
    });
    if (eventError) throw eventError;

    return jsonResponse(
      { match, player: toPlayerSummary(player as Record<string, unknown>) },
      { origin },
    );
  });
});

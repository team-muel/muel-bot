import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  getGameUser,
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
    const [match, user] = await Promise.all([getMatch(matchId), getGameUser(claims.sub)]);

    if (match.status !== "lobby") {
      throw conflict("match_not_joinable", "Only lobby matches can be joined.");
    }

    const supabase = getSupabaseAdmin();
    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .upsert(
        {
          match_id: match.id,
          user_id: user.id,
          display_name: user.displayName,
          avatar_url: user.avatarUrl,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "match_id,user_id" },
      )
      .select("*")
      .single();
    if (playerError) throw playerError;

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: match.id,
      event_type: "player_joined",
      visibility: "public",
      payload: { userId: user.id, displayName: user.displayName },
    });
    if (eventError) throw eventError;

    return jsonResponse(
      { match, player: toPlayerSummary(player as Record<string, unknown>) },
      { origin },
    );
  });
});

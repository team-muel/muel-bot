import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  readJsonObject,
  readRequiredString,
  reconcileLobbyPresence,
  toMatchSummary,
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
    const discordChannelId = readRequiredString(body, "discordChannelId");

    const supabase = getSupabaseAdmin();
    // 1. Get matches
    const { data: matchesData, error: matchesError } = await supabase
      .from("matches")
      .select("*")
      .eq("context_type", "discord_voice")
      .eq("context_id", discordChannelId)
      .eq("status", "lobby")
      .order("created_at", { ascending: true });

    if (matchesError) throw matchesError;

    const matches = (matchesData ?? []).map((m) => toMatchSummary(m as Record<string, unknown>));
    const matchIds = matches.map((m) => m.id);

    // 표시 전 각 로비의 유령 플레이어를 정리해 playerCounts 가 실제 접속자를 반영하도록 한다.
    await Promise.all(
      matchIds.map((id) =>
        reconcileLobbyPresence(id).catch((err) => {
          console.error("[match-list] reconcileLobbyPresence failed", id, err);
        }),
      ),
    );

    // 2. Get counts of players in these matches
    const playerCounts: Record<string, number> = {};
    for (const matchId of matchIds) {
      playerCounts[matchId] = 0;
    }

    if (matchIds.length > 0) {
      const { data: countsData, error: countsError } = await supabase
        .from("match_players")
        .select("match_id")
        .in("match_id", matchIds);

      if (countsError) throw countsError;

      for (const row of countsData ?? []) {
        const mid = String(row.match_id);
        playerCounts[mid] = (playerCounts[mid] || 0) + 1;
      }
    }

    return jsonResponse({ matches, playerCounts }, { origin });
  });
});

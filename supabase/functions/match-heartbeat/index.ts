import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, reconcileLobbyPresence } from "../_shared/game.ts";

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

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("match_players")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .select("user_id");

    if (error) throw error;
    if (!data || data.length === 0) {
      throw forbidden("not_in_match", "이 매치에 참가해 있지 않습니다.");
    }

    // 본인 last_seen 갱신 후 유령 플레이어 GC. 활성 클라가 30s 마다 들르는 경로라
    // 로비 presence 가 지속적으로 정리된다. (실패해도 하트비트 자체는 성공 처리)
    await reconcileLobbyPresence(matchId).catch((err) => {
      console.error("[match-heartbeat] reconcileLobbyPresence failed", err);
    });

    return jsonResponse({ success: true }, { origin });
  });
});

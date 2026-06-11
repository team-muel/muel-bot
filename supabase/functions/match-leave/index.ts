import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { getMatch, readJsonObject, readRequiredString } from "../_shared/game.ts";

// 본인이 로비에서 나간다(Activity 종료/이탈 시 best-effort 호출). 잔류 row 제거.
// 진행 중인 매치 이탈은 게임을 깨므로 여기선 로비만 처리(그 외 no-op).
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

    const match = await getMatch(matchId);
    if (match.status !== "lobby") {
      return jsonResponse({ success: true, skipped: "not_lobby" }, { origin });
    }

    const supabase = getSupabaseAdmin();

    const { data: removed, error: deleteError } = await supabase
      .from("match_players")
      .delete()
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .select("user_id");
    if (deleteError) throw deleteError;

    // M-5: only emit player_left if the caller was actually in the match.
    if (!removed || removed.length === 0) {
      return jsonResponse({ success: true, skipped: "not_in_match" }, { origin });
    }

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: "player_left",
      visibility: "public",
      payload: { userId: claims.sub },
    });
    if (eventError) throw eventError;

    // 빈 테이블 자동 소멸: 로비에서 마지막 플레이어가 나가면 abort
    const { count, error: countError } = await supabase
      .from("match_players")
      .select("user_id", { count: "exact", head: true })
      .eq("match_id", matchId);

    if (countError) throw countError;

    if (count === 0) {
      const { error: abortError } = await supabase
        .from("matches")
        .update({
          status: "aborted",
          abort_reason: "empty_table",
          ended_at: new Date().toISOString(),
        })
        .eq("id", matchId);
      if (abortError) throw abortError;
    }

    return jsonResponse({ success: true }, { origin });
  });
});

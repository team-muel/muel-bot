import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString } from "../_shared/game.ts";

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

    // 하트비트는 본인 last_seen 갱신만 한다 (MUE-85). 유령 플레이어 GC 는
    // 저빈도 경로(match-join·match-list)와 phase-advance 의 presence sweep 이
    // 담당한다 — 활성 클라 N 명이 30s 마다 로비 전체 GC 를 돌리던 구조를 제거.
    return jsonResponse({ success: true }, { origin });
  });
});

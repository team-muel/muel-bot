import { preflight, jsonResponse } from "../_shared/cors.ts";
import { badRequest, conflict, forbidden, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  NEUTRAL_MODES,
  getMatch,
  readJsonObject,
  readRequiredString,
  toMatchSummary,
} from "../_shared/game.ts";

// 방장이 로비에서 게임 설정을 바꾼다 (M3-1). 허용 키만 골라 settings jsonb 에 머지 —
// 임의 키 주입 금지. 현재 허용: neutral("auto"|"on"|"off", 중립 등장 모드, 결정 잠금 #2).
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

    // 허용 키 allowlist — 하나 이상 있어야 한다.
    const patch: Record<string, unknown> = {};
    if ("neutral" in body) {
      const neutral = readRequiredString(body, "neutral");
      if (!(NEUTRAL_MODES as readonly string[]).includes(neutral)) {
        throw badRequest("invalid_neutral_mode", "neutral 은 auto|on|off 중 하나여야 합니다.");
      }
      patch.neutral = neutral;
    }
    if (Object.keys(patch).length === 0) {
      throw badRequest("no_settings", "변경할 설정이 없습니다.");
    }

    const match = await getMatch(matchId);
    if (match.status !== "lobby") {
      throw conflict("not_lobby", "로비에서만 설정을 바꿀 수 있습니다.");
    }
    if (match.hostUserId !== claims.sub) {
      throw forbidden("not_host", "방장만 설정을 바꿀 수 있습니다.");
    }

    const supabase = getSupabaseAdmin();
    const { data: updated, error: updateError } = await supabase
      .from("matches")
      .update({ settings: { ...match.settings, ...patch } })
      .eq("id", matchId)
      .eq("status", "lobby") // 레이스 가드: 그 사이 시작됐으면 0행 갱신
      .select("*")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) {
      throw conflict("not_lobby", "로비에서만 설정을 바꿀 수 있습니다.");
    }

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: "settings_updated",
      visibility: "public",
      payload: { byUserId: claims.sub, patch },
    });
    if (eventError) throw eventError;

    return jsonResponse(
      { success: true, match: toMatchSummary(updated as Record<string, unknown>) },
      { origin },
    );
  });
});

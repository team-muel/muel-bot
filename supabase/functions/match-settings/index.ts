import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch, toMatchSummary } from "../_shared/game.ts";
import { NEUTRAL_MODES, type NeutralMode } from "../_shared/neutral.ts";

/**
 * match-settings — 로비 게임 설정 변경 (M3-1 백엔드 짝).
 *
 * muel-tree 로비의 중립 토글(updateMatchSettings)이 호출한다. 호스트만, 로비
 * 상태에서만. 현재 지원 설정: neutral("auto"|"on"|"off") — 해석은 match-start 의
 * rollNeutralSpawn(_shared/neutral.ts) 단일 출처. 반영 전파는 matches realtime.
 */
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
    const neutral = readRequiredString(body, "neutral");

    if (!(NEUTRAL_MODES as readonly string[]).includes(neutral)) {
      throw badRequest("invalid_neutral", "neutral 은 auto/on/off 중 하나여야 합니다.");
    }

    const match = await getMatch(matchId);
    if (match.status !== "lobby") {
      throw conflict("invalid_status", "게임 설정은 로비에서만 바꿀 수 있습니다.");
    }
    if (match.hostUserId !== claims.sub) {
      throw forbidden("not_host", "방장만 게임 설정을 바꿀 수 있습니다.");
    }

    const supabase = getSupabaseAdmin();
    // 레거시 includeNeutral 잔재는 제거하고 neutral 로 일원화한다.
    const { includeNeutral: _legacy, ...restSettings } = match.settings;
    const nextSettings = { ...restSettings, neutral: neutral as NeutralMode };

    const { data, error } = await supabase
      .from("matches")
      .update({ settings: nextSettings })
      .eq("id", matchId)
      .select()
      .single();
    if (error) throw error;

    return jsonResponse(
      { success: true, match: toMatchSummary(data as Record<string, unknown>) },
      { origin },
    );
  });
});

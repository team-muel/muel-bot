import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

// 채팅 발화 — 채널은 페이즈+상태로 서버가 결정한다(정본 2026-06-15):
//   밤  : 회로원(circleChat)만 'demon_circle' 밀회.
//   낮  : 생존자 → 'town'(전원 열람), 사망자 → 'dead'(영혼, 사망자만 열람).
// 그 외 페이즈는 채팅 불가. 읽기 가시성은 RLS(20260615140000) 가 강제한다.
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
    const message = readRequiredString(body, "message");
    if (message.length > 2000) {
      throw badRequest("message_too_long", "메시지가 너무 깁니다 (2000자 이내).");
    }

    const supabase = getSupabaseAdmin();
    const match = await getMatch(matchId);

    const { data: currentPhase, error: phaseError } = await supabase
      .from("match_phases")
      .select("id")
      .eq("match_id", matchId)
      .is("ended_at", null)
      .order("phase_number", { ascending: false })
      .limit(1)
      .single();
    if (phaseError || !currentPhase) {
      throw conflict("no_active_phase", "현재 활성화된 페이즈가 없습니다.");
    }

    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .select("alive, engine_state")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .single();
    if (playerError || !player) throw forbidden("not_participant", "게임 참가자가 아닙니다.");

    // 채널 결정.
    let channel: "demon_circle" | "town" | "dead";
    if (match.status === "night") {
      if (!player.alive) throw forbidden("dead_player", "사망한 플레이어는 밤 회로에 참여할 수 없습니다.");
      const inCircle = ((player.engine_state as { circleChat?: unknown } | null)?.circleChat) === true;
      if (!inCircle) throw forbidden("invalid_role", "접선된 회로가 없습니다.");
      channel = "demon_circle";
    } else if (match.status === "day") {
      channel = player.alive ? "town" : "dead";
    } else {
      throw badRequest("invalid_phase", "지금은 채팅할 수 없습니다.");
    }

    const { error: chatError } = await supabase
      .from("match_chats")
      .insert({
        match_id: matchId,
        phase_id: currentPhase.id,
        channel,
        sender_user_id: claims.sub,
        message,
      });
    if (chatError) throw chatError;

    return jsonResponse({ success: true, channel }, { origin });
  });
});

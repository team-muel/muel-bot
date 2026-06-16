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

    // 호스트(방 생성자)가 나가면 호스트를 위임한다 — 위임 안 되면 host_user_id 가
    // 떠난 유저를 가리킨 채 남아 게임 시작이 막힌다(start 는 호스트 권한 필요).
    // 위임 대상은 '사람' 참가자만(is_ai=false). AI 용병에게는 절대 위임하지 않는다.
    // 남은 사람이 없으면(AI 만 남음/전원 이탈) 로비를 abort 한다.
    if (match.hostUserId === claims.sub) {
      const { data: humans, error: humansError } = await supabase
        .from("match_players")
        .select("user_id")
        .eq("match_id", matchId)
        .eq("is_ai", false)
        .order("joined_at", { ascending: true })
        .limit(1);
      if (humansError) throw humansError;

      const newHostId = humans?.[0]?.user_id as string | undefined;
      if (newHostId) {
        // 새 호스트 지정 + is_host 플래그 재배치(새 호스트만 true).
        const { error: hostError } = await supabase
          .from("matches")
          .update({ host_user_id: newHostId })
          .eq("id", matchId)
          .eq("status", "lobby");
        if (hostError) throw hostError;

        await supabase
          .from("match_players")
          .update({ is_host: false })
          .eq("match_id", matchId)
          .neq("user_id", newHostId);
        await supabase
          .from("match_players")
          .update({ is_host: true })
          .eq("match_id", matchId)
          .eq("user_id", newHostId);

        await supabase.from("match_events").insert({
          match_id: matchId,
          event_type: "host_changed",
          visibility: "public",
          payload: { hostUserId: newHostId, reason: "host_left" },
        });
      } else {
        // 남은 게 AI 뿐 → 사람 호스트가 없다(AI 에 위임 금지). 로비를 닫는다.
        await supabase
          .from("matches")
          .update({
            status: "aborted",
            abort_reason: "host_left_no_humans",
            ended_at: new Date().toISOString(),
          })
          .eq("id", matchId)
          .eq("status", "lobby");
        return jsonResponse({ success: true, aborted: "host_left_no_humans" }, { origin });
      }
    }

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

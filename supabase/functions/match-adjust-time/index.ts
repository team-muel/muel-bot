import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

/**
 * match-adjust-time — 토론(day) 시간 조절. 각 유저는 그 토론(현재 day 페이즈)에서 1회만,
 * 시간을 깎거나(-20초) 늘릴(+10초) 수 있다. "유저당 1회 총량" — 깎기/늘리기 합쳐 한 번.
 *
 * 가드: (1) status==='day', (2) 그 day 페이즈에서 호출자가 아직 조절 안 함(match_actions
 * 의 time_cut/time_extend 부재), (3) 깎을 때 잔여시간이 음수가 되지 않게 클램프(최소 now+5초).
 * 서버가 match_phases.expected_ended_at 을 갱신하고(phase-advance 가 그 값으로 전환),
 * 공개 이벤트로 전원에게 변경을 통지한다.
 */
const CUT_SEC = 20;
const EXTEND_SEC = 10;
const MIN_REMAIN_SEC = 5;

Deno.serve((req: Request) => {
  return withErrorHandling(req, async () => {
    const origin = req.headers.get("Origin");
    const pre = preflight(req);
    if (pre) return pre;

    if (req.method !== "POST") {
      return jsonResponse({ error: { code: "method_not_allowed", message: "POST only." } }, { status: 405, origin });
    }

    const claims = await requireGameAuth(req);
    const body = readJsonObject(await req.json().catch(() => null));
    const matchId = readRequiredString(body, "matchId");
    const direction = readRequiredString(body, "direction"); // "cut" | "extend"
    if (direction !== "cut" && direction !== "extend") {
      throw badRequest("invalid_direction", "direction 은 'cut' 또는 'extend' 여야 합니다.");
    }

    const supabase = getSupabaseAdmin();
    const match = await getMatch(matchId);
    if (match.status !== "day") {
      throw conflict("invalid_phase", "지금은 토론(낮) 단계가 아닙니다.");
    }

    // 호출자가 살아있는 참가자인지 확인.
    const { data: actor } = await supabase
      .from("match_players")
      .select("alive")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .single();
    if (!actor) throw conflict("not_participant", "게임 참가자가 아닙니다.");
    if (!actor.alive) throw conflict("dead", "탈락자는 토론 시간을 조절할 수 없습니다.");

    // 현재 열린 day 페이즈.
    const { data: phase } = await supabase
      .from("match_phases")
      .select("id, expected_ended_at")
      .eq("match_id", matchId)
      .eq("phase_type", "day")
      .is("ended_at", null)
      .order("phase_number", { ascending: false })
      .limit(1)
      .single();
    if (!phase) throw conflict("no_day_phase", "조절할 토론 페이즈가 없습니다.");

    // 유저당 1회 총량 — 이 페이즈에서 이미 깎기/늘리기를 했으면 거부.
    const { data: prior } = await supabase
      .from("match_actions")
      .select("id")
      .eq("phase_id", phase.id)
      .eq("actor_user_id", claims.sub)
      .in("action_type", ["time_cut", "time_extend"])
      .limit(1);
    if (prior && prior.length > 0) {
      throw conflict("already_adjusted", "이번 토론에서는 이미 시간을 조절했습니다.");
    }

    // 새 종료 시각 계산(깎기는 음수 방지 클램프).
    const now = Date.now();
    const current = Date.parse(phase.expected_ended_at as string);
    const deltaMs = (direction === "cut" ? -CUT_SEC : EXTEND_SEC) * 1000;
    let next = current + deltaMs;
    const floor = now + MIN_REMAIN_SEC * 1000;
    if (next < floor) next = floor;
    const nextIso = new Date(next).toISOString();

    const actionType = direction === "cut" ? "time_cut" : "time_extend";
    const { error: actionError } = await supabase.from("match_actions").insert({
      phase_id: phase.id,
      match_id: matchId,
      actor_user_id: claims.sub,
      action_type: actionType,
      target_user_id: null,
      submitted_at: new Date().toISOString(),
    });
    if (actionError) throw actionError;

    const { error: phaseError } = await supabase
      .from("match_phases")
      .update({ expected_ended_at: nextIso })
      .eq("id", phase.id);
    if (phaseError) throw phaseError;

    await supabase.from("match_events").insert({
      match_id: matchId,
      phase_id: phase.id,
      event_type: "discussion_time_adjusted",
      visibility: "public",
      payload: { direction, delta_sec: direction === "cut" ? -CUT_SEC : EXTEND_SEC, expected_ended_at: nextIso, by: claims.sub },
    });

    return jsonResponse({ success: true, expectedEndedAt: nextIso }, { origin });
  });
});

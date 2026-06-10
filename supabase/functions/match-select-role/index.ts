import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

/**
 * match-select-role — 변종 선택 배정(canon §5). role_assign 단계에서 악마/조력자 슬롯
 * 플레이어가 자기 풀(대악마/팬텀/말렌/베스토 · 가인/루나/로건/엘런)에서 직업을 고른다.
 *
 * 슬롯·풀은 match-start 가 engine_state.pendingSelection={kind,pool} 으로 심어둔다.
 * 여기서는 (1) role_assign 단계인지, (2) 호출자가 선택 대기 슬롯인지, (3) 고른 직업이
 * 그 풀에 있는지 검증하고 role 을 확정 + pendingSelection 제거한다. 미선택은
 * phase-advance(role_assign 만료)가 풀에서 랜덤 폴백한다. 가인→악마 보호막 재계산도 거기서.
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
    const chosenRole = readRequiredString(body, "role");

    const supabase = getSupabaseAdmin();
    const match = await getMatch(matchId);
    if (match.status !== "role_assign") {
      throw conflict("invalid_phase", "지금은 직업 선택 단계가 아닙니다.");
    }

    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .select("role, engine_state")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .single();

    if (playerError || !player) throw forbidden("not_participant", "게임 참가자가 아닙니다.");

    const engineState = (player.engine_state ?? {}) as Record<string, unknown>;
    const pending = engineState.pendingSelection as { kind?: string; pool?: unknown } | undefined;
    const pool = Array.isArray(pending?.pool) ? (pending!.pool as string[]) : null;

    if (!pending || !pool) {
      throw conflict("no_selection", "선택할 직업이 없습니다.");
    }
    if (!pool.includes(chosenRole)) {
      throw badRequest("invalid_choice", "선택할 수 없는 직업입니다.");
    }

    // pendingSelection 제거 + role 확정. (보호막 등 파생 상태는 선택 마감 시 재계산.)
    const nextState: Record<string, unknown> = { ...engineState };
    delete nextState.pendingSelection;

    const { error: updateError } = await supabase
      .from("match_players")
      .update({ role: chosenRole, engine_state: nextState })
      .eq("match_id", matchId)
      .eq("user_id", claims.sub);

    if (updateError) throw updateError;

    return jsonResponse({ success: true, role: chosenRole }, { origin });
  });
});

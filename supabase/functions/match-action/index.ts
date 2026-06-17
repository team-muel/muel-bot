import { preflight, jsonResponse } from "../_shared/cors.ts";
import { badRequest, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString } from "../_shared/game.ts";
import { submitMatchAction } from "../_shared/match-action-core.ts";

export function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw badRequest("invalid_field", `${key} must be a string.`);
  }
  return value.trim() || null;
}

// 사람 플레이어의 행동 제출. 검증+기록은 match-action-core(submitMatchAction)에 단일화 —
// AI(match-ai-act)도 같은 코어를 거친다(ADR-005).
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
    const actionType = readRequiredString(body, "actionType");
    const targetUserId = readOptionalString(body, "targetUserId");
    // 멀티타깃(아서 잔불이 꺼지기 전에=3명): 문자열 배열만 통과시킨다. 단일 능력은 생략 가능.
    const rawIds = (body as Record<string, unknown>).targetUserIds;
    const targetUserIds = Array.isArray(rawIds)
      ? rawIds.filter((x): x is string => typeof x === "string")
      : undefined;

    const supabase = getSupabaseAdmin();
    const { investigationResult } = await submitMatchAction(supabase, {
      matchId,
      actorUserId: claims.sub,
      actionType,
      targetUserId,
      targetUserIds,
    });

    return jsonResponse({ success: true, investigationResult }, { origin });
  });
});

import { preflight, jsonResponse } from "../_shared/cors.ts";
import { badRequest, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import {
  findMyActiveMatch,
  readJsonObject,
} from "../_shared/game.ts";

// Resolve an open match for the caller's Discord Activity context.
// Prefers the Activity instance_id (one match per Activity instance); falls back
// to the voice channel id for backward compatibility with older clients.
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
    const instanceId =
      typeof body.instanceId === "string" && body.instanceId.trim() ? body.instanceId.trim() : null;
    const discordChannelId =
      typeof body.discordChannelId === "string" && body.discordChannelId.trim()
        ? body.discordChannelId.trim()
        : null;

    if (!instanceId && !discordChannelId) {
      throw badRequest("missing_field", "instanceId 또는 discordChannelId 가 필요합니다.");
    }

    const match = await findMyActiveMatch(claims.sub, discordChannelId ?? "", instanceId);

    return jsonResponse(match, { origin });
  });
});

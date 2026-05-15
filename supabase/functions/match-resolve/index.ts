import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import {
  findOpenMatchByDiscordChannel,
  readJsonObject,
  readRequiredString,
} from "../_shared/game.ts";

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

    await requireGameAuth(req);
    const body = readJsonObject(await req.json().catch(() => null));
    const discordChannelId = readRequiredString(body, "discordChannelId");
    const match = await findOpenMatchByDiscordChannel(discordChannelId);

    return jsonResponse(match, { origin });
  });
});

// GET /health — used by the bot launcher and by uptime checks to confirm the
// Mafia game server is reachable. Does not require auth (config.toml overrides
// verify_jwt to false for this function).

import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";

Deno.serve((req: Request) => {
  return withErrorHandling(req, async () => {
    const pre = preflight(req);
    if (pre) return pre;

    if (req.method !== "GET") {
      return jsonResponse(
        { error: { code: "method_not_allowed", message: "GET only." } },
        { status: 405, origin: req.headers.get("Origin") },
      );
    }

    return jsonResponse(
      {
        ok: true,
        service: "muel-game-server",
        time: new Date().toISOString(),
      },
      { origin: req.headers.get("Origin") },
    );
  });
});

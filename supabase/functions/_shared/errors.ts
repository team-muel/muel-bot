// Common error helpers for game Edge Functions.

import { jsonResponse } from "./cors.ts";

export class GameError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}

export function badRequest(code: string, message: string): GameError {
  return new GameError(400, code, message);
}

export function unauthorized(code: string, message: string): GameError {
  return new GameError(401, code, message);
}

export function forbidden(code: string, message: string): GameError {
  return new GameError(403, code, message);
}

export function notFound(code: string, message: string): GameError {
  return new GameError(404, code, message);
}

export function conflict(code: string, message: string): GameError {
  return new GameError(409, code, message);
}

export function internal(code: string, message: string): GameError {
  return new GameError(500, code, message);
}

/**
 * Run a request handler and convert any thrown error into a JSON response.
 * - GameError → JSON with code+message at the declared status
 * - Response thrown (auth guard pattern) → returned directly
 * - Anything else → 500 with "internal_error"
 */
export async function withErrorHandling(
  req: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const origin = req.headers.get("Origin");
  try {
    return await handler();
  } catch (err) {
    if (err instanceof Response) return err;
    if (err instanceof GameError) {
      return jsonResponse({ error: { code: err.code, message: err.message } }, {
        status: err.status,
        origin,
      });
    }
    console.error("[edge] unhandled error:", err);
    return jsonResponse(
      { error: { code: "internal_error", message: "Unexpected server error." } },
      { status: 500, origin },
    );
  }
}

// Game JWT issuance + verification.
//
// Strategy (per phase1-design §3.7-f):
// We sign our own JWT with the same JWT secret Supabase uses to issue its own
// JWTs. That way RLS's auth.jwt() will validate game-issued tokens naturally,
// and the `sub` claim carries mafia.users.id (uuid) which RLS helper functions
// (mafia.current_game_user_id()) read.
//
// Required env vars:
//   GAME_JWT_SECRET — same value as Supabase project's Legacy JWT Secret
//
// Token shape (claims):
//   sub: <mafia.users.id, uuid string>
//   role: 'authenticated'    ← Supabase RLS expects this
//   aud: 'authenticated'
//   iat, exp, iss

import { create, verify, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const ALG = "HS256";
const ISS = "muel-game-server";
const TTL_SECONDS = 60 * 60 * 8; // 8h. Matches reasonable session length.

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const secret = Deno.env.get("GAME_JWT_SECRET");
  if (!secret) {
    throw new Error("GAME_JWT_SECRET must be set in the Edge Function environment.");
  }
  const enc = new TextEncoder();
  cachedKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return cachedKey;
}

export type GameJwtClaims = {
  sub: string; // mafia.users.id
  role: "authenticated";
  aud: "authenticated";
  iat: number;
  exp: number;
  iss: typeof ISS;
};

export async function issueGameJwt(userId: string): Promise<string> {
  const key = await getKey();
  const now = getNumericDate(0);
  const claims: GameJwtClaims = {
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: getNumericDate(TTL_SECONDS),
    iss: ISS,
  };
  return await create({ alg: ALG, typ: "JWT" }, claims, key);
}

export async function verifyGameJwt(token: string): Promise<GameJwtClaims> {
  const key = await getKey();
  const payload = (await verify(token, key)) as GameJwtClaims;
  if (payload.iss !== ISS) {
    throw new Error("invalid issuer");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("missing sub");
  }
  return payload;
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * Auth guard for game-protected endpoints. Returns the claim set or throws a
 * Response (401) on failure.
 */
export async function requireGameAuth(req: Request): Promise<GameJwtClaims> {
  const token = extractBearer(req);
  if (!token) {
    throw new Response(JSON.stringify({ error: "missing bearer token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    return await verifyGameJwt(token);
  } catch (_e) {
    throw new Response(JSON.stringify({ error: "invalid game token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
}

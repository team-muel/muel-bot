// Allowed origins for the Mafia game API.
// Discord Activity iframes resolve to *.discordsays.com; muel-tree is on Vercel.

const ALLOWED_PATTERNS: RegExp[] = [
  /^https:\/\/[\w-]+\.discordsays\.com$/,
  /^https:\/\/muel-tree\.vercel\.app$/,
  /^https:\/\/[\w-]+\.muel-tree\.vercel\.app$/, // preview deployments
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(origin));
}

export function corsHeaders(origin: string | null): HeadersInit {
  const allow = origin && isAllowedOrigin(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("Origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { origin?: string | null } = {},
): Response {
  const { origin = null, headers, ...rest } = init;
  const merged = new Headers(corsHeaders(origin));
  if (headers) {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      merged.set(k, v);
    }
  }
  merged.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...rest, headers: merged });
}

# Shared modules for the Mafia game Edge Functions

These files are imported by sibling functions (auth-exchange, match-create, …).
They are not deployable on their own.

## Files

- `cors.ts` — Origin allowlist, preflight handler, JSON response helper.
- `supabase-admin.ts` — Service-role Supabase client. Server-side only. Bypasses RLS.
- `jwt.ts` — Game JWT issue/verify using the Supabase JWT secret. Auth guard.
- `errors.ts` — `GameError` class + `withErrorHandling` wrapper.

## Required environment variables

Set these via `supabase secrets set` (or in the Edge Functions dashboard):

- `SUPABASE_URL` — auto-injected for hosted functions
- `SUPABASE_SERVICE_ROLE_KEY` — auto-injected
- `GAME_JWT_SECRET` — Dashboard → JWT Keys → **Legacy JWT Secret** tab. Supabase
  CLI rejects user-defined secrets with the reserved `SUPABASE_` prefix, so this
  project uses `GAME_JWT_SECRET` for the same value.
  (the new "JWT Signing Keys" UI is the asymmetric system; Phase 1 uses HS256
  legacy. Do NOT click "Create Standby Key".)
- `GOMDORI_DISCORD_CLIENT_ID`, `GOMDORI_DISCORD_CLIENT_SECRET` — Gomdori
  Discord application credentials. Used by `auth-exchange` when handling
  Gomdori OAuth code grants. **Not** the Muel Bot app's credentials —
  Gomdori is a separate Discord application (factory model: one Discord
  app per Activity).
- Future Activities (e.g. Weave migrating off Muel Bot app) add their own
  `<APP>_DISCORD_CLIENT_ID/SECRET` pair and a corresponding case in
  `auth-exchange`'s slug switch.

For local development:
- Copy `.env.example` to `supabase/functions/.env.local`
- Run with `supabase functions serve --env-file supabase/functions/.env.local`

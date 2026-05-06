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
- `SUPABASE_JWT_SECRET` — same value as Project Settings → API → JWT Secret
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` — used by auth-exchange (later)

For local development:
- Copy `.env.example` to `supabase/functions/.env.local`
- Run with `supabase functions serve --env-file supabase/functions/.env.local`

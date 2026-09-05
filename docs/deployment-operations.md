# Muel Bot Deployment Operations

Last updated: 2026-09-05

## Runtime Boundary

`muel-bot` is the always-on Discord Gateway process for Muel infrastructure.
It can host both the Muel bot client and the Gomdori launcher client, but that
is an implementation detail. Product identity stays separate:

- Muel: platform, assistant, hub, Weave, subscriptions, memory/context spine.
- Gomdori: separate product experience using Muel infrastructure; current app
  is Gomdori Mafia at `https://muel-tree.vercel.app/game`.

## Current Hosting Decision

Use Render for the Discord Gateway process and Vercel for the web app.

Do not move the current `discord.js` Gateway bot to Vercel Functions. Vercel is
appropriate for HTTP request/response handlers and webhooks, but not for a
process that must keep a Discord websocket open indefinitely.

Render Free web services spin down after idle time, which disconnects the
Discord Gateway clients unless an external monitor keeps the service warm.

Current no-cost operating mode used Render Free plus UptimeRobot hitting
`https://muel-bot.onrender.com/health` every 5 minutes. That is an MVP keep-warm
workaround, not the production target.

For production-grade operation, use an always-on Render instance type.
`render.yaml` now targets `plan: starter`.

## Required Render Service Settings

- Service: `muel-bot`
- Service ID: `srv-d7srr3ugkk3c73djc320`
- Type: Web Service
- Runtime: Node
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Instance type: `starter` or higher
- Health check path: `/health`
- Readiness check: `/ready`
- Auto deploy: commit-triggered deploys from the linked Git branch

Required environment variables:

- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_PUBLIC_KEY`
- `GOMDORI_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY`
- `NVIDIA_API_KEY`
- `MINDLOGIC_API_KEY`
- `HUB_URL=https://muel-tree.vercel.app`

Optional tuning variables:

- `MUEL_AI_MODEL`
- `MUEL_CHAT_PROVIDER`
- `MINDLOGIC_CHAT_MODEL`
- `MINDLOGIC_MODEL`
- `MUEL_HEAVY_PROVIDER`
- `NVIDIA_HEAVY_MODEL`
- `MUEL_EMBEDDING_MODEL`
- `MUEL_EMBEDDING_DIMENSIONS`
- `NVIDIA_MODEL`
- `YOUTUBE_MONITOR_INTERVAL_MS`
- `YOUTUBE_MONITOR_CONCURRENCY` (default `3`; shared by source checks, WebSub renewal, and lifecycle row updates)
- `JOB_WORKER_CONCURRENCY` (default `2`; bounds claimed-job fan-out)
- `YOUTUBE_FETCH_TIMEOUT_MS`
- `ENABLE_JOB_WORKER`
- `ENABLE_YOUTUBE_MONITOR`
- `ENABLE_HTTP_INTERACTIONS`
- `REGISTER_DISCORD_COMMANDS_ON_READY` (default `false`; enable only for a deliberate command-definition rollout, then disable again)
- `MENTION_REPLY_TIMEOUT_MS`
- `GOMDORI_APPLICATION_PUBLIC_KEY`

Never print raw token values in chat, docs, logs, or screenshots.

Supabase Fair Use `402` responses activate a process-wide circuit breaker. Database-backed pollers and telemetry writes pause for 60 seconds initially and back off exponentially to 15 minutes; Discord mention replies degrade to stateless mode. The job worker, prompt overlay loader, and Archivist share recovery probes, and Archivist automatically retries initialization after the circuit closes. Inspect `/ready` fields `supabaseRestriction.nextProbeAt`, `jobWorker.currentDelayMs`, and `archivist.retryScheduled`; restarts reset the in-memory backoff.

## Current Health Checks

Use these checks after every deploy:

```powershell
Invoke-RestMethod https://muel-bot.onrender.com/health
Invoke-RestMethod https://muel-bot.onrender.com/ready | ConvertTo-Json -Depth 6
Invoke-RestMethod https://muel-bot.onrender.com/ | ConvertTo-Json -Depth 6
npm run typecheck
```

Supabase migrations, Edge Functions, and cron operations use
`docs/supabase-operations-playbook.md`. Follow that playbook when a change
touches `supabase/migrations`, `supabase/functions`, `pg_cron`, `pg_net`, or the
Gomdori `mafia` schema.

Expected runtime shape:

- `/health` returns `200 OK` when Muel and the configured Gomdori client are connected to Discord. Unexplained disconnections or pending logins return `503`. During an explicit Discord `Retry-After` interval it returns HTTP 200 with `ok: false`, `waitingForDiscord: true` and retry deadlines, so Render preserves the waiting process instead of repeating blocked login requests. This is process health, not command readiness.
- `/live` returns `200 OK` whenever the HTTP process is alive; do not use it as the Render deployment health check.
- `/ready` returns `200` when ready, `503` with `degradedReasons` when not.
- `/discord/interactions` is configured only when HTTP interactions are intentionally enabled.
- JSON root has `ok: true`.
- `muel.wsStatus` is `0` after warmup.
- `gomdori.wsStatus` is `0` after warmup when `GOMDORI_BOT_TOKEN` is set.
- `loginError` is `null`; if it is not null, treat the service as degraded.
- A null `loginError` does not establish readiness: a pending login can have no error yet. Check `wsStatus`, `/health`, and the `[muel-connection]` / `[gomdori-connection]` logs for gateway discovery, REST rate limits, and shard transitions. Respect Discord's reported retry delay.
- Root JSON `commit` identifies `RENDER_GIT_COMMIT` for deployment verification.
- Root JSON `muel.retryAt` / `gomdori.retryAt` exposes an active Gateway discovery rate-limit deadline; `/ready` remains 503 until the bots actually connect. Do not restart or change IPs to bypass a Discord restriction. discord.js retries after the server's deadline.

## 2026-09-05 Discord connection incident

The process stayed up with both clients at `wsStatus: 3`, no bot identity, and no login error. Gateway discovery diagnostics confirmed HTTP 429 for both clients with the same `Retry-After: 39832` seconds at 04:52 UTC. Thus server slash commands could not reach their handlers. The former unconditional `/health` concealed the outage. Shared egress throttling is possible, but the response alone does not establish who exhausted the limit. The command handler's separate DM support defect was fixed in #247.

Muel and Gomdori are small single-shard applications. Startup therefore uses Discord's unauthenticated Get Gateway endpoint and a fixed single-shard configuration instead of Get Gateway Bot, whose extra shard recommendation and session-limit metadata are only needed for larger/sharded apps. The official `wss://gateway.discord.gg` URL is the validated fallback. Other authenticated Discord REST routes are unchanged. This removes the blocked route from cold starts; moving to a Render Pro workspace with dedicated outbound IPs is the infrastructure-level option if shared egress affects other Discord REST calls.

Command registration is disabled during ordinary startup. Existing global commands remain registered at Discord, so re-uploading the same manifest on every cold start only consumes REST capacity and used to block all runtime services behind the request. When command definitions change, set `REGISTER_DISCORD_COMMANDS_ON_READY=true` for one deployment or call `/admin/reregister-commands` with the configured admin token, verify registration, then turn automatic registration off. YouTube monitoring, jobs, and Archivist now start before any optional registration request.

## Known 2026-05-14 Finding

The bot was reachable after a cold request but needed about 27 seconds to wake.
That is the Render Free spin-up path, not a normal always-on bot state.

Render API confirmed the remote service still reports `plan=free` as of this
check. The remote health check path has been updated to `/health`.

UptimeRobot is already configured for `https://muel-bot.onrender.com/health`
with a 5-minute interval, so the current free-tier workaround is intentional.
Treat this as acceptable MVP/dev uptime, but not the same as a paid always-on
instance. If UptimeRobot is paused, rate-limited, or misses checks long enough,
the service can still sleep or recover through cold-start behavior.

The Gomdori client was logged in, but command registration reported:

```text
You cannot remove this app's Entry Point command in a bulk update operation.
Please include the Entry Point command in your update request or delete it separately.
```

The code now includes a Gomdori Primary Entry Point command in the bulk command
update. After the next Render deploy, confirm the root JSON no longer reports
that as `gomdori.loginError`.

## Escalation Rules

If the bot is offline:

1. Check `https://muel-bot.onrender.com/` and note cold-start latency.
2. Check the UptimeRobot monitor for pause state, interval, and recent incidents.
3. Check Render service state, latest deploy, and logs.
4. Confirm Render instance type or current keep-warm policy.
5. Confirm required env vars are present without exposing values.
6. Confirm both Discord applications still have valid bot tokens.
7. Run `npm run typecheck` locally before changing production code.
8. Redeploy through Git/Render after config or code changes.

If the bot must stay free:

- Keep UptimeRobot active against `/health` at a 5-minute interval or faster.
- Treat keep-alive pings as an MVP/dev workaround, not a production SLO.
- Convert only HTTP interaction/webhook surfaces to Vercel/Supabase Edge
  Functions.
- Keep Gateway-only features, such as message listeners and long-lived monitors,
  on an always-on host.

# Muel Bot Deployment Operations

Last updated: 2026-05-14

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

Current no-cost operating mode is Render Free plus UptimeRobot hitting
`https://muel-bot.onrender.com/health` every 5 minutes. That interval is short
enough to prevent the normal idle spin-down path when the monitor is healthy.

For production-grade operation, use an always-on Render instance type, currently
declared as `plan: starter` in `render.yaml`.

## Required Render Service Settings

- Service: `muel-bot`
- Service ID: `srv-d7srr3ugkk3c73djc320`
- Type: Web Service
- Runtime: Node
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Instance type: `starter` or higher
- Health check path: `/health`
- Auto deploy: commit-triggered deploys from the linked Git branch

Required environment variables:

- `DISCORD_BOT_TOKEN`
- `GOMDORI_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY`
- `NVIDIA_API_KEY`
- `HUB_URL=https://muel-tree.vercel.app`

Optional tuning variables:

- `MUEL_AI_MODEL`
- `NVIDIA_MODEL`
- `YOUTUBE_MONITOR_INTERVAL_MS`
- `YOUTUBE_FETCH_TIMEOUT_MS`

Never print raw token values in chat, docs, logs, or screenshots.

## Current Health Checks

Use these checks after every deploy:

```powershell
Invoke-RestMethod https://muel-bot.onrender.com/health
Invoke-RestMethod https://muel-bot.onrender.com/ | ConvertTo-Json -Depth 6
npm run typecheck
```

Expected runtime shape:

- `/health` returns `OK`.
- JSON root has `ok: true`.
- `muel.wsStatus` is `0` after warmup.
- `gomdori.wsStatus` is `0` after warmup when `GOMDORI_BOT_TOKEN` is set.
- `loginError` is `null`; if it is not null, treat the service as degraded.

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

# Muel Discord Bot

`muel-bot` is the Render-hosted Discord bot for the Muel Platform.

## Terms

- **Muel Platform**: the overall brand and product system.
- **Muel Discord Bot**: this repository, deployed on Render.
- **Muel Web App**: the separate `muel-tree` repository, deployed on Vercel.
- **Hub**: the public `/` page in `muel-tree`.
- **Activity**: a Discord Activity route in `muel-tree`, such as `/weave` (user command: `/일기`).
- **Product**: an individual service such as Muel, Black or White, or 세계수.

## Features

- Connects the bot user to Discord.
- Registers the public slash commands: `/도움말`, `/일기`, `/구독`, and `/ping`.
- Replies when users mention the bot in Discord, using the Muel conversation spine.
- Shows the Muel hub, 일기 Activity, and Server invite from `/도움말`.
- Clears guild-scoped legacy commands on startup so Discord does not show duplicate command entries.
- Keeps `/구독` as the Muel utility for YouTube video/community post procurement.
- Sends regular videos as channel messages; community posts show as much body text as Discord allows and spill the rest into a thread, while Shorts get a small thread.
- Exposes a tiny HTTP health endpoint required by Render Web Services.
- Exposes `/health` for liveness and `/ready` for degraded-state inspection.

## Environment

Required:

- `DISCORD_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `HUB_URL` — defaults to `https://muel-tree.vercel.app`
- `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` — enables AI mention replies
- `MUEL_AI_MODEL` — defaults to `gemini-2.5-flash`
- `MUEL_EMBEDDING_MODEL` — defaults to `gemini-embedding-001`
- `MUEL_EMBEDDING_DIMENSIONS` — defaults to `768`
- `NVIDIA_API_KEY` and `NVIDIA_MODEL` — optional fallback provider, default model `meta/llama-3.3-70b-instruct`
- `ENABLE_JOB_WORKER` — defaults to `true`; `ENABLE_MEMORY_WORKER` is still accepted as a legacy alias
- `ENABLE_YOUTUBE_MONITOR` — defaults to `true`
- `ENABLE_HTTP_INTERACTIONS` — defaults to `false`
- `MENTION_REPLY_TIMEOUT_MS` — defaults to `15000`
- `DISCORD_APPLICATION_PUBLIC_KEY` — required when `ENABLE_HTTP_INTERACTIONS=true`
- `GOMDORI_APPLICATION_PUBLIC_KEY` — optional second signature key for Gomdori HTTP interactions

## Mention Replies

Muel responds when mentioned in a server channel. This requires the Discord Developer Portal **Message Content Intent** to be enabled for the bot application, and the Render service must have `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` set.

The mention path stays direct: inbound messages are written to Supabase, Muel calls the AI SDK, and the reply is sent back to Discord in the same interaction path. Memory extraction remains asynchronous.

## HTTP Interactions

When `ENABLE_HTTP_INTERACTIONS=true`, Discord slash commands can be served from `POST /discord/interactions`.
Gateway message listening remains enabled for mentions and reply-context capture.

Inbound and outbound messages are stored in Supabase:

- `muel_chats`
- `muel_messages_v2`
- `muel_jobs` for deferred extraction and background work
- `muel_memory_entries` / `muel_memory_embeddings` for long-term memory

## Runtime note

Production should use an always-on Render instance. Free-tier keep-warm pings are acceptable for MVP testing, but they are not equivalent to a production uptime target for a Discord gateway process.

## Local run

```bash
npm install
npm run dev
```

## Render

Create a Render Web Service from this repo. Render can use `render.yaml`, or set:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check path: `/health`
- Readiness check: `/ready`
- Discord interactions endpoint: `/discord/interactions`

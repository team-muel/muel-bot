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

## Environment

Required:

- `DISCORD_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `HUB_URL` — defaults to `https://muel-tree.vercel.app`
- `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` — enables AI mention replies
- `MUEL_AI_MODEL` — defaults to `gemini-2.5-flash`

## Mention Replies

Muel responds when mentioned in a server channel. This requires the Discord Developer Portal **Message Content Intent** to be enabled for the bot application, and the Render service must have `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` set.

Inbound and outbound messages are stored in Supabase:

- `muel_conversations`
- `muel_messages`
- `muel_events`

## Render Free note

This uses a free Render Web Service because Render does not offer free Background Workers. Free Web Services sleep after inactivity, so the bot might go offline when the service is spun down.

## Local run

```bash
npm install
npm run dev
```

## Render

Create a Render Web Service from this repo. Render can use `render.yaml`, or set:

- Build command: `npm ci && npm run build`
- Start command: `npm start`

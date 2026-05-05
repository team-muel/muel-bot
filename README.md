# Muel Discord Bot

`muel-bot` is the Render-hosted Discord bot for the Muel Platform.

## Terms

- **Muel Platform**: the overall brand and product system.
- **Muel Discord Bot**: this repository, deployed on Render.
- **Muel Web App**: the separate `muel-tree` repository, deployed on Vercel.
- **Hub**: the public `/` page in `muel-tree`.
- **Activity**: a Discord Activity route in `muel-tree`, such as `/weave`.
- **Product**: an individual service such as Muel, Black or White, or 세계수.

## Features

- Connects the bot user to Discord.
- Registers only the minimal public slash commands: `/도움말`, `/구독`, and `/ping`.
- Shows the Muel hub and Weave entry route from `/도움말`.
- Clears guild-scoped legacy commands on startup so Discord does not show duplicate command entries.
- Keeps `/구독` as the Muel utility for YouTube video/community post procurement.
- Sends regular videos as channel messages; community posts show as much body text as Discord allows and spill the rest into a thread, while Shorts get a small thread.
- Exposes a tiny HTTP health endpoint required by Render Web Services.

## Environment

Required:

- `DISCORD_BOT_TOKEN`

Optional:

- `HUB_URL` — defaults to `https://muel-tree.vercel.app`

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

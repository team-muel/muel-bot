# muel-bot

Minimal Muel Discord bot for Render Free Web Service.

## Features

- Connects the bot user to Discord.
- Registers slash commands including `/ping` and `/도움말`.
- Shows the Muel hub site from `/도움말`.
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

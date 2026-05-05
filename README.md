# muel-bot

Minimal Muel Discord bot for Render.

## Features

- Connects the bot user to Discord.
- Registers one slash command: `/ping`.
- Polls YouTube community posts from Supabase `sources` rows every 5 minutes and posts new items to Discord.

## Environment

Required:

- `DISCORD_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Supabase `sources` rows

The monitor expects active YouTube community subscriptions in `public.sources`.

- `url`: YouTube channel URL or channel id. Recommended format: `https://www.youtube.com/channel/UC...#posts`
- `channel_id`: target Discord channel id
- `last_post_signature`: latest posted YouTube community post id
- `is_active`: `true`

Use `supabase/sources.sql` as the minimal schema/migration reference.

## Local run

```bash
npm install
npm run dev
```

## Render

Create a Render worker from this repo. Render can use `render.yaml`, or set:

- Build command: `npm ci && npm run build`
- Start command: `npm start`

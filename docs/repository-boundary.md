# Repository Boundary

`muel-bot` is the current Discord bot repository for Muel.

`discord-news-bot` is shut down and should be treated as historical reference only.

## Current Repository

- Repository: `muel-bot`
- Role: small Render-hosted Discord bot for the current Muel platform
- Current command surface: `/도움말`, `/메모`, `/허브`, `/구독`, `/ping`
- Current utility focus: Muel hub entry, memory capture/correction, Weave entry, YouTube video/community procurement
- Current operations layer: optional private Discord MCP server for Codex/Cowork/Claude Code

## Product Boundary: Muel vs. Gomdori

`muel-bot` and `muel-tree` are shared implementation repositories. They are not the product taxonomy.

- **Muel** is the platform and identity layer: the main assistant surface, memory/context spine, hub entry, Weave memory correction surface, subscriptions, service registry, and shared infrastructure.
- **Gomdori** is a separate product experience inside the Muel platform: the mafia game, its own Discord application, its own Activity route, and its own game server state under the `mafia` schema.
- Sharing `muel-bot` and `muel-tree` is an implementation choice. It must not collapse product naming, Discord app ownership, secrets, OAuth credentials, or UX language back into "Muel Bot."
- New miniapps should follow the same factory model: shared Muel infrastructure, product-specific Discord/Toss credentials, product-specific routes, and product-specific user-facing names.

Operationally, `muel-bot` may host both the Muel bot client and the Gomdori launcher client, but Gomdori should be treated as its own product and Discord app. Codex should say "Gomdori uses Muel infrastructure" rather than "Gomdori is Muel Bot."

## Historical Reference Only

`discord-news-bot` may still contain useful patterns, warnings, or old control-tower ideas, but it is not the active service.

Do not infer active product direction from `discord-news-bot` unless the user explicitly asks for archaeology or migration.

Common examples of historical-only material:

- broad news automation
- heavy dashboards
- old command sprawl
- old agent/control-plane experiments
- legacy environment variables

## Operating Rule

When working on Muel's Discord bot today:

1. Use `muel-bot` as implementation truth.
2. Use `muel-tree` as the web app and Activity truth.
3. Use `discord-news-bot` only as cautionary reference.
4. Keep the bot command surface thin unless the user explicitly asks to expand it.

Deployment operations live in `docs/deployment-operations.md`. The short
version: this repository owns the always-on Discord Gateway process, so
the current no-cost runtime is Render Free kept warm by UptimeRobot. Vercel
Functions are not the target runtime for this Gateway bot.

AI runtime planning lives in `docs/ai-sdk-routing-plan.md`. The short version:
`muel-bot` owns the primary AI SDK provider policy and should move toward
task-specific model lanes for chat, routing, extraction, summaries, heavy
fallback, and embeddings.

## Discord MCP Meaning

If `mcp__muel_discord__` appears in Codex, that means the private Discord MCP server is exposed to the current Codex session.

It does not mean `discord-news-bot` is alive.

The MCP server controls whichever Discord application is attached to the configured `DISCORD_BOT_TOKEN`.

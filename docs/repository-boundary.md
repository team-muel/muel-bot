# Repository Boundary

`muel-bot` is the current Discord bot repository for Muel.

`discord-news-bot` is shut down and should be treated as historical reference only.

## Current Repository

- Repository: `muel-bot`
- Role: small Render-hosted Discord bot for the current Muel platform
- Current command surface: `/도움말`, `/일기`, `/구독`, `/ping`
- Current utility focus: Muel hub entry, Weave entry, YouTube video/community procurement
- Current operations layer: optional private Discord MCP server for Codex/Cowork/Claude Code

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

## Discord MCP Meaning

If `mcp__muel_discord__` appears in Codex, that means the private Discord MCP server is exposed to the current Codex session.

It does not mean `discord-news-bot` is alive.

The MCP server controls whichever Discord application is attached to the configured `DISCORD_BOT_TOKEN`.

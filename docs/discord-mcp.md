# Muel Discord MCP Server

This repository includes a private local MCP server for controlling the Discord application attached to `DISCORD_BOT_TOKEN`.

It is not deployed to Render. Run it only on a trusted local machine.

## What It Can Do

- Read the current Discord application.
- List servers where the bot is installed.
- List global and guild-scoped slash commands.
- Upsert one global or guild-scoped command.
- Delete one global or guild-scoped command.
- Clear guild-scoped commands for one server.
- Send a plain text bot message to a channel.

Destructive tools require `confirm: true`.

## Environment

Required:

- `DISCORD_BOT_TOKEN`

Optional:

- `DISCORD_APPLICATION_ID`

If `DISCORD_APPLICATION_ID` is omitted, the MCP server asks Discord for the current application using the bot token.

## Local Run

```bash
npm install
npm run mcp:discord
```

After building:

```bash
npm run build
npm run mcp:discord:start
```

## Claude Code Wiring

Add a server entry to `.claude/settings.json` or your user-level Claude Code MCP settings:

```json
{
  "mcpServers": {
    "muel-discord": {
      "command": "node",
      "args": [
        "C:\\Users\\fancy\\Documents\\Codex\\2026-05-05\\obsidian-rag-memory-eval-observer-crm\\muel-bot\\dist\\mcpServer.js"
      ],
      "env": {
        "DISCORD_BOT_TOKEN": "use-your-local-secret",
        "DISCORD_APPLICATION_ID": "optional-application-id"
      }
    }
  }
}
```

Do not commit real token values.

## Codex / Cowork Wiring

Codex can use the same MCP server if the host app is configured to launch it as an MCP process.

The important parts are:

- command: `node`
- args: path to `dist/mcpServer.js`
- env: `DISCORD_BOT_TOKEN`, optionally `DISCORD_APPLICATION_ID`

Cowork can wrap the same command as a plugin later. The server itself is intentionally plain stdio MCP so it can be reused by Claude Code, Codex, and other MCP-capable hosts.

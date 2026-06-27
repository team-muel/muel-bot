# Muel Context Window

Muel's context window is the bounded working memory assembled before one LLM
call. It is not the model's maximum token limit, and it is not permission to
read every Discord surface. The window is a typed bundle of prompt sections,
recent conversation, memory, image instructions, and tool availability for the
current turn.

## Goals

- Keep Discord replies grounded without making Muel look omniscient.
- Keep casual turns cheap and small.
- Include user memory only when the turn is substantive enough to need it.
- Keep channel/thread catch-up behind explicit intent and read-only tools.
- Log safe diagnostics about what was included without storing raw prompt text.

## Current Builder

`src/muelContextWindow.ts` owns the context-window policy used by
`generateMuelReply`.

The builder returns:

- `system`: final system prompt string.
- `messages`: recent conversation transformed for AI SDK input.
- `hasImage`: whether the latest window contains a live image part.
- `lightweightTurn`: whether the turn should stay on the cheap lane.
- `toolsEnabled`: whether read-only context tools should be exposed.
- `diagnostics`: safe metadata about mode, message count, sections, and memory
  inclusion.

## Modes

- `lightweight`: empty or short casual turns. Recent conversation is capped to
  four messages and memory retrieval is skipped.
- `normal`: substantive chat without a clear retrieval/admin/catch-up shape.
- `recall`: memory-oriented turns such as "what do you remember about me".
- `catchup`: channel/thread/news/digest style turns where tools are preferred
  over stuffing long channel text into the prompt.
- `admin`: hub, subscription, status, profile, or server-management context.

Modes are intentionally conservative. They do not grant new Discord powers; they
only decide how much existing context to assemble and whether read-only tools
are visible to the model.

## Discord Boundaries

- Default scope is the current turn and current channel context provided by the
  caller.
- Older Discord CDN image URLs are replaced with a textual note; only the latest
  image remains visible to the model.
- Mentioned users get compact interaction summaries only.
- Stored user memory is skipped for lightweight turns and never blocks chat if
  retrieval fails.
- Tool calls remain read-only and must not expose raw IDs, raw JSON, stack
  traces, or internal function names to users.

## Extension Points

The next useful additions are policy changes inside the builder, not ad hoc
prompt growth in `muelAgent.ts`.

- Add section-level character caps before increasing global message count.
- Add safe context-window event logging if production observability needs it.
- Add an optional `get_context_summary` tool later for explicit catch-up flows.
  Do not make that the primary context path; baseline context must be assembled
  before the model decides which tools to call.

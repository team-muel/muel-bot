# AI SDK Routing Plan

This document defines the intended AI runtime shape for `muel-bot`.

## Goal

Use AI SDK as a small set of task-specific runtime lanes instead of treating one
general chat model as the engine for every workflow.

`muel-bot` remains the primary AI execution surface for Muel Platform. It owns
Discord mention replies, memory extraction, YouTube/community post
transformation, background jobs, provider fallback, and AI event logging.

`muel-tree` should stay focused on web UI, Activity routes, auth, and Gemini
long-running operation facades.

## Model Lanes

Keep the existing `MUEL_AI_MODEL` behavior as a compatibility fallback, but
prefer explicit lanes:

- `MUEL_CHAT_MODEL`: Discord mention replies and character voice.
- `MUEL_ROUTER_MODEL`: cheap pre-generation classification.
- `MUEL_EXTRACT_MODEL`: structured extraction for memory, dreams, posts, and
  metadata.
- `MUEL_SUMMARY_MODEL`: community, channel, and YouTube summaries.
- `MUEL_HEAVY_MODEL`: expensive escalation for complex reasoning, risky
  ambiguity, architecture, or repeated structured-output failure.
- `MUEL_EMBEDDING_MODEL`: vector retrieval and similarity.
- `MUEL_EMBEDDING_DIMENSIONS`: explicit expected embedding width.

Flash-class models should be the default for router, extract, summary, and
background worker lanes. Heavy models should be escalation targets, not the
default runtime.

## Router Contract

Before a full mention reply, a cheap router can classify non-trivial input into
one action:

- `direct_reply`
- `use_tools`
- `enqueue_job`
- `escalate`
- `refuse`
- `clarify`

Recommended router fields:

- `action`
- `reason`
- `toolHints`
- `memorySearch`
- `maxResponseTokens`
- `riskLevel`

The router should reduce unnecessary retrieval, tool calls, and long prompts.
It must not become final authority for irreversible actions.

## Structured Output

Extraction workflows should use AI SDK object generation with schemas and
validation. Regex JSON extraction should be treated as a migration target.

Candidate extraction lanes:

- long-term memory candidate extraction and merge decisions
- YouTube community post rendering
- Weave dream emotions, keywords, and main tag
- future digest or service-event metadata

Expected behavior:

1. Validate model output against a schema.
2. Retry within a small budget when validation fails.
3. Log validation failures by task type and model.
4. Fall back or escalate when repeated failures happen.

## Model Registry

Centralize provider construction and model selection in one helper rather than
creating providers in each module.

Responsibilities:

- resolve model by task lane
- normalize provider names and model IDs
- define fallback order
- attach provider-specific tools only where allowed
- expose task metadata for AI event logging

This prevents `muelAgent`, `memoryWorker`, `youtubeMonitor`, and future workers
from drifting into separate provider policies.

## Hot Path Rule

Discord mention handling should stay short:

1. preflight guard
2. local fallback for trivial greetings and health checks
3. router when useful
4. short generated reply
5. save assistant message
6. enqueue memory extraction asynchronously

Background workers should handle extraction, embedding, summarization, dedupe,
and future digest jobs.

## Capability Expansion Rule

AI SDK expansion is split into three layers:

1. **Read-only tools**: safe status/catch-up surfaces that return compact text
   to the model. Current examples are `get_recent_messages`, `get_thread`,
   `get_hub_status`, and `get_subscription_status`.
2. **Action drafts**: schema-first object classification for reversible
   operations. The classifier may propose `hub_activate` or `hub_deactivate`,
   but it cannot mutate Discord or the database.
3. **Confirmed executors**: deterministic handlers behind Discord buttons.
   They re-check requester identity, guild/channel context, and
   `ManageChannels` before calling existing write paths.

Do not add heuristic natural-language switches for write actions. New write
capabilities should be added only when they have:

- a schema entry in the action draft classifier,
- a clear permission rule,
- a confirmation UI,
- an existing deterministic executor or slash-command path to reuse,
- audit logging in `muel_agent_actions`.

YouTube subscription add/remove is deliberately not enabled in the action draft
path yet; it needs a richer select/button UI for kind, channel target, and link
validation. Until then, users should use `/구독`.

## Observability

AI event logging should record:

- task type
- provider
- model
- latency
- fallback reason
- structured output validation result
- retry count
- approximate token or cost metadata when available
- user-visible failure category

The point is to decide the Flash-vs-heavy split from runtime evidence rather
than preference.

## Migration Order

1. Add model lane env vars with `MUEL_AI_MODEL` fallback.
2. Add a model registry helper.
3. Move provider construction into the registry.
4. Add task type labels to current AI calls.
5. Convert extraction call sites to schema-first object flows.
6. Add router only after event logging can show the before/after effect.

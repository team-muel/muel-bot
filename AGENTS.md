# Agent operating contract

This repository runs user-facing automation and integrations. Agents must preserve runtime isolation, explicit authority, and safe external side effects.

## Source of truth

- Linear owns scope, priority, dependencies, and delivery state.
- GitHub owns implementation evidence: commits, pull requests, reviews, CI, releases, and deployments.
- Slack owns coordination and operational discussion.
- Notion owns durable architecture and runbooks.

When a Linear issue key is available, use it to understand intent and acceptance criteria.

## Non-negotiable invariants

1. Do not weaken startup isolation, command registration boundaries, or failure containment for convenience.
2. Do not introduce external writes, notifications, or destructive side effects without an explicit execution path and testable guardrail.
3. Never commit real Discord, Supabase, Google, OpenAI, or other service credentials.
4. Preserve idempotency for retried jobs and event handlers where duplicate delivery is possible.
5. Treat migrations and persistent state changes as compatibility-sensitive. Prefer additive, reversible changes when practical.
6. Keep smoke tests runnable without live production credentials.
7. Do not silently broaden permissions or scopes for connected services.

## Before implementation

- Read relevant modules, tests, migrations, and existing operational docs before editing.
- Identify external side effects and retry behavior.
- Prefer small, single-purpose changes with explicit failure handling.
- For integrations, preserve observability and actionable error messages.

## Before requesting review

Run the checks applicable to the change. The current baseline includes:

```bash
npm ci
npm run typecheck
npm run test:smoke
```

Also run any focused tests or build commands required by the changed subsystem.

Document:

- what changed and why,
- external side effects,
- failure and retry behavior,
- migration or compatibility impact,
- verification performed.

## Review protocol

Review in this order:

1. Correctness and runtime isolation.
2. External side effects and authority boundaries.
3. Retry/idempotency behavior.
4. Credential and permission handling.
5. Persistent-state and migration safety.
6. Negative-path and regression tests.
7. Maintainability.

Material review findings must be fixed or explicitly dispositioned before merge.

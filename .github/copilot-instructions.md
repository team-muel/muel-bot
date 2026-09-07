# Copilot review instructions

Prioritize runtime isolation, safe external side effects, retries, credential handling, and migration compatibility.

When reviewing a pull request:

1. Verify startup and command-registration boundaries remain explicit.
2. Identify every external write or notification path and confirm it is intentional and guarded.
3. Check duplicate-delivery and retry behavior for idempotency.
4. Flag broadened OAuth/API permissions, secret exposure, or production credential assumptions.
5. Treat Supabase migrations and persistent-state changes as compatibility-sensitive.
6. Require meaningful negative-path coverage for failure-prone integrations.
7. Use linked Linear issue context when available to detect scope drift.

Do not treat correctness, security, or operational findings as optional style suggestions.

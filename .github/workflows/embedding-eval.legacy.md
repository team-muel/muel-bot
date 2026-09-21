# Legacy: Embedding Eval

**Retired:** 2026-09-22  
**Former workflow:** `.github/workflows/embedding-eval.yml`  
**Former schedule:** Mondays at 12:00 UTC  
**State:** Retired / non-executable

## Why this was retired

The scheduled embedding regression job depended on a live Google Generative AI API key and had become an unattended external-provider integration rather than a reliable product-quality gate.

By 2026-09-22:

- the scheduled job had failed for at least five consecutive weekly runs because `GOOGLE_GENERATIVE_AI_API_KEY` was unavailable to GitHub Actions;
- the workflow still pinned Node 20 while the repository requires Node >=24;
- repairing the credential would restore recurring provider calls without a clear operational owner or a strong current product need;
- provider/API-key lifecycle and policy changes can make this style of live-key scheduled eval brittle.

The executable GitHub Actions workflow was therefore removed so it cannot consume runner or provider resources.

## What remains

The historical evaluation harness is intentionally preserved in:

- `tests/embeddings/embedding-eval.ts`
- package script `legacy:eval:embeddings`
- git history for the retired workflow and past runs

The harness is legacy reference material, not a supported operational gate.

## Replacement criteria

Do not simply restore the old cron workflow. A future embedding/retrieval evaluation system should preferably provide:

1. explicit ownership and failure-response routing;
2. provider-neutral or reproducible datasets where possible;
3. bounded cost/resource budgets;
4. no unattended dependency on a personal or fragile live API key;
5. runtime versions aligned with the repository;
6. clear metrics tied to the actual retrieval/memory product path;
7. a documented decision on whether the check is CI-blocking, scheduled observability, or an on-demand benchmark.

If a live provider evaluation is still valuable, it should be introduced as a new system with those contracts rather than reviving this workflow.

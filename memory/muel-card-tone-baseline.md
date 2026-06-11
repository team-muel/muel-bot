---
name: muel-card-tone-baseline
description: muel-bot embed color baseline — Muel's first-party cards use brand green (muel tone), not violet
metadata:
  type: feedback
---

For muel-bot Discord embeds, the canonical accent for Muel's own first-party UI (system/status/memory/help/game cards: `/메모`, `/롤링페이퍼`, propose-memo, `/도감`) is the **brand green `0xa2e61d`** — the `muel` tone documented in `src/rendering/types.ts` tone policy. Centralized in `src/uiColors.ts` as `MUEL_BRAND_COLOR`. Status tones: `warning` `0xff3b30`, `success` `0x34c759`; external feeds (YouTube/News) use colorless `neutral`.

**Why:** When asked to "unify the info-card purple," I first assumed the most recently-built card's violet (`0x9b87f5`, propose-memo) was the baseline and pushed it onto more cards (PR #119). The user pushed back ("왜 보라색이야") — the violet was the *odd-one-out*, never in the tone policy. The real baseline was the green `/메모` cards already use. Fixed in PR #120.

**How to apply:** Don't infer a design baseline from the newest or most-salient instance. Check the documented tone policy / the most-established surface first. For Muel cards, default to the `muel` brand-green tone unless it's a status (warning/success) or an external feed (neutral). New first-party card → `tone: 'muel'`. See [[muel-bot-fix-pr-workflow]].

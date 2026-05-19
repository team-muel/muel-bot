# Community Flow Signals

Muel should not try to understand every Discord message with a large hand-written
rule tree. The current MVP watches server flow cheaply, stores a signal when a
channel becomes unusually active, and lets an asynchronous LLM job summarize the
sampled context.

## Runtime Shape

1. `MessageCreate` pushes non-bot messages into the in-memory channel buffer.
2. `observeCommunityMessage` groups messages into short channel buckets.
3. When a bucket reaches the volume threshold, Muel stores one
   `muel_community_signals` row with sampled recent messages.
4. Muel enqueues `summarize_community_flow` with a delayed `run_after` time so
   the discussion can settle before summarization.
5. The job worker calls the LLM and writes a `muel_community_digests` row.

The hot path must remain non-blocking. Signal insert or enqueue failure should
log and return without blocking ordinary Discord messages or mention replies.

## Product Boundary

- Muel owns community observation, curation, memory, and assistant behavior.
- Gomdori owns game and Discord Activity behavior.
- The two products may share repositories, Render, Vercel, and Supabase, but
  user-facing copy should keep the products distinct.

## Current Limits

- Detection is intentionally volume-based only.
- Digests are stored for later use; they are not posted back into Discord yet.
- The LLM prompt must default to Korean and must not invent facts that are not
  visible in the sampled messages.

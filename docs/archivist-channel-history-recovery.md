# Scoped channel history recovery

## Why

The initial backwards backfill stops permanently at `backfill_done=true`. Gateway ingestion alone cannot recover messages sent during an outage. Rich-payload reconciliation does not insert missing message rows. Consequently a healthy gateway and a completed initial backfill do not prove continuous historical coverage.

## Scope and activation

Set `ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS` to a comma-separated allowlist (at most 10 IDs). Empty disables this worker. Only registered `GuildText` channels inside `OWNED_GUILD_ID` are accepted. View Channel and Read Message History permissions are required before treating an empty REST page as catch-up. No Discord messages are sent, edited, or deleted. No new secrets or database schema are needed.

The worker starts independently of the initial backfill, uses the existing `history_reconcile_cursor` column as a forward verification checkpoint, and never derives its progress from the newest streamed message. If a cursor is absent, it starts after the channel creation snowflake. Before activating a large channel, an operator may seed its cursor to the last verified message immediately before a known outage, preserving the original state in the incident record.

## Recovery semantics

- Fetch at most 100 messages per page and 10 pages per slice using Discord `after` pagination.
- Compare identifiers as BigInt, sort oldest first, reject non-advancing responses.
- Insert missing primary rows and their rich payload through existing ArchiveStore safeguards.
- Repair incomplete rich payload for existing non-tombstoned rows; leave healthy payload untouched.
- Save a checkpoint only after successful persistence. Compare-and-set guards against stale cursor writers.
- Only an empty successful REST page sets `history_reconcile_version=1` and `history_reconciled_at`.
- Backlog slices retry after 15 seconds; caught-up channels check again after 60 seconds. Errors back off from 60 seconds up to 15 minutes, preserving progress. These are process timer targets, not uptime guarantees.
- Restarts resume from the stored checkpoint. The initial backwards backfill state is unchanged.
- A caught-up result proves traversal of the selected source interval, not historical completeness before the seed, availability of deleted source messages, or uninterrupted Dyno logging.

## Verification and rollback

`getArchivistStatus()` exposes `channelHistoryReconcile` with last error, checked/repair counts, and completion time. Compare daily archive counts, missing rich payload, event pairing, and the source timestamp of the stored checkpoint before publishing voice statistics. Store source coverage and analysis cutoff with every report.

Disable by removing the channel ID from the environment allowlist and redeploying. Retain recovered rows; do not delete them for rollback. Rewind only the scoped forward checkpoint when another audited repair is required. Never reset all channel backfill states or weaken RLS.

Tests: `npm run test:archivist` includes pagination, persistence failure, checkpoint conflicts, bounded replay, short-page handling, invalid scope, empty-source handling, and exact snowflake ordering.

import type { Client, Message } from 'discord.js';
import type { ArchiveStore } from './store.js';

type CursorRow = { id: string };
type SliceOptions<T extends CursorRow> = {
  cursor: string;
  fetchPage: (after: string) => Promise<T[]>;
  persist: (rows: T[]) => Promise<void>;
  checkpoint: (cursor: string, caughtUp: boolean) => Promise<void>;
  maxPages?: number;
};

/** Persist first, then advance a durable forward cursor. Empty pages alone
 * certify catch-up; neither a stream high-water mark nor a short page does. */
export const reconcileForwardSlice = async <T extends CursorRow>(options: SliceOptions<T>) => {
  let cursor = options.cursor;
  if (!/^\d+$/.test(cursor)) throw new Error('invalid history cursor');
  const maxPages = options.maxPages ?? 10;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('invalid history page budget');
  }
  let checked = 0;
  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    const raw = await options.fetchPage(cursor);
    if (raw.length === 0) {
      await options.checkpoint(cursor, true);
      return { cursor, caughtUp: true, checked };
    }
    if (raw.some((row) => !/^\d+$/.test(row.id) || BigInt(row.id) <= BigInt(cursor))) {
      throw new Error('history page did not advance strictly after cursor');
    }
    const rows = [...new Map(raw.map((row) => [row.id, row])).values()]
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    await options.persist(rows);
    const newest = rows[rows.length - 1].id;
    await options.checkpoint(newest, false);
    cursor = newest;
    checked += rows.length;
  }
  return { cursor, caughtUp: false, checked };
};

export const parseHistoryChannelIds = (raw: string): string[] => {
  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 10 || ids.some((id) => !/^\d{17,20}$/.test(id))) {
    throw new Error('ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS must contain at most 10 channel snowflakes');
  }
  return ids;
};

export const channelHistoryReconcileStatus = {
  running: false,
  inProgress: false,
  channelIds: [] as string[],
  lastCompletedAt: null as string | null,
  lastError: null as string | null,
  checkedMessages: 0,
  repairedMessages: 0,
  phase: 'idle',
  phaseStartedAt: null as string | null,
  activeChannelId: null as string | null,
  lastSourceHttpStatus: null as number | null,
  lastSourceRetryAfter: null as string | null,
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Observe stalled SDK waits without cancelling them or issuing overlapping
// requests. Discord's Retry-After remains owned by the existing REST client.
let phaseTimer: NodeJS.Timeout | null = null;
const setHistoryPhase = (phase: string, channelId: string | null = null): void => {
  if (phaseTimer) clearTimeout(phaseTimer);
  channelHistoryReconcileStatus.phase = phase;
  channelHistoryReconcileStatus.phaseStartedAt = new Date().toISOString();
  channelHistoryReconcileStatus.activeChannelId = channelId;
  if (phase === 'idle') return;
  phaseTimer = setTimeout(() => {
    console.warn('[archivist] channel history pending ' + JSON.stringify({
      phase, channelId,
      phaseStartedAt: channelHistoryReconcileStatus.phaseStartedAt,
      lastSourceHttpStatus: channelHistoryReconcileStatus.lastSourceHttpStatus,
      retryAfter: channelHistoryReconcileStatus.lastSourceRetryAfter,
      action: 'preserve cursor and await existing request; no overlapping retry',
    }));
  }, 60_000);
  phaseTimer.unref();
};

/** Disabled unless explicitly scoped. Existing backfill and thread cursors
 * are not reset. No Discord writes, schema changes, or new credentials. */
export const startChannelHistoryReconcileWorker = (client: Client<true>, store: ArchiveStore): void => {
  if (channelHistoryReconcileStatus.running) return;
  let ids: string[];
  try {
    ids = parseHistoryChannelIds(process.env.ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS ?? '');
  } catch (error) {
    channelHistoryReconcileStatus.lastError = errorMessage(error);
    console.warn('[archivist] channel history configuration rejected', { error: errorMessage(error) });
    return;
  }
  if (ids.length === 0) return;
  channelHistoryReconcileStatus.running = true;
  channelHistoryReconcileStatus.channelIds = ids;
  let failures = 0;
  console.log('[archivist] channel history worker enabled ' + JSON.stringify({ channels: ids.length }));
  const sourceRoutes = new Set(ids.flatMap((id) => [`/channels/${id}`, `/channels/${id}/messages`]));
  client.rest.on('response', (request, response) => {
    if (!sourceRoutes.has(String(request.route).split('?')[0])) return;
    channelHistoryReconcileStatus.lastSourceHttpStatus = response.status;
    channelHistoryReconcileStatus.lastSourceRetryAfter = response.headers.get('retry-after');
    if (response.status >= 400) {
      console.warn('[archivist] channel history HTTP ' + JSON.stringify({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        scope: response.headers.get('x-ratelimit-scope'),
      }));
    }
  });

  const tick = async (): Promise<void> => {
    channelHistoryReconcileStatus.inProgress = true;
    let delayMs = 60_000;
    try {
      const { getSupabaseClient } = await import('../supabase.js');
      const { ChannelType, PermissionFlagsBits } = await import('discord.js');
      const db = getSupabaseClient().schema('archive');
      let allCaughtUp = true;
      for (const channelId of ids) {
        setHistoryPhase('read_checkpoint', channelId);
        const { data: state, error: stateError } = await db.from('channels')
          .select('channel_id,type,history_reconcile_cursor')
          .eq('guild_id', store.guildId).eq('channel_id', channelId).single();
        if (stateError || !state) throw new Error(`history state: ${stateError?.message ?? 'missing channel'}`);
        if (state.type !== 'GuildText') throw new Error(`history target is not GuildText: ${channelId}`);
        setHistoryPhase('resolve_discord_channel', channelId);
        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== store.guildId) {
          throw new Error(`history channel outside owned text scope: ${channelId}`);
        }
        if (!channel.permissionsFor(client.user)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
        ])) throw new Error(`history read permission missing: ${channelId}`);

        let expectedCursor: string | null = state.history_reconcile_cursor ?? null;
        let repaired = 0;
        const result = await reconcileForwardSlice<Message<true>>({
          // Channel creation precedes its messages. Never start at MAX(message_id):
          // gateway writes can jump across an unverified outage interval.
          cursor: expectedCursor ?? channelId,
          maxPages: 10,
          fetchPage: async (after) => {
            setHistoryPhase('fetch_discord_messages', channelId);
            const page = await channel.messages.fetch({ after, limit: 100, cache: false });
            return [...page.values()];
          },
          persist: async (rows) => {
            if (rows.some((row) => row.channelId !== channelId || row.guildId !== store.guildId)) {
              throw new Error('history page crossed configured scope');
            }
            setHistoryPhase('compare_archived_payload', channelId);
            const messageIds = rows.map((row) => row.id);
            const [existing, richText, embeds, components] = await Promise.all([
              db.from('messages').select('message_id,tombstoned').in('message_id', messageIds),
              db.from('message_rich_text').select('message_id').in('message_id', messageIds),
              db.from('message_embeds').select('message_id').in('message_id', messageIds),
              db.from('message_components').select('message_id').in('message_id', messageIds),
            ]);
            for (const query of [existing, richText, embeds, components]) {
              if (query.error) throw new Error(`history payload lookup: ${query.error.message}`);
            }
            const known = new Map((existing.data ?? []).map((row: any) => [String(row.message_id), Boolean(row.tombstoned)]));
            const projected = new Set((richText.data ?? []).map((row: any) => String(row.message_id)));
            const countById = (values: Array<{ message_id: unknown }> | null) => {
              const counts = new Map<string, number>();
              for (const row of values ?? []) {
                const id = String(row.message_id);
                counts.set(id, (counts.get(id) ?? 0) + 1);
              }
              return counts;
            };
            const embedCounts = countById(embeds.data);
            const componentCounts = countById(components.data);
            const missing = rows.filter((row) => !known.has(row.id));
            const incomplete = rows.filter((row) => known.has(row.id) && !known.get(row.id) && (
              !projected.has(row.id)
              || (embedCounts.get(row.id) ?? 0) < row.embeds.length
              || (componentCounts.get(row.id) ?? 0) < row.components.length
            ));
            // Healthy archived payloads and explicit tombstones are untouched.
            // A failed partial insert is repaired on replay before checkpointing.
            setHistoryPhase('persist_missing_messages', channelId);
            await store.ingestBackfillPage(missing);
            setHistoryPhase('persist_incomplete_rich_payload', channelId);
            await store.ingestEmbedBackfillPage(incomplete);
            repaired += missing.length + incomplete.length;
          },
          checkpoint: async (cursor, caughtUp) => {
            setHistoryPhase('save_checkpoint', channelId);
            let query = db.from('channels').update({
              history_reconcile_cursor: cursor,
              history_reconcile_version: caughtUp ? 1 : 0,
              history_reconciled_at: caughtUp ? new Date().toISOString() : null,
            }).eq('guild_id', store.guildId).eq('channel_id', channelId);
            // Refuse stale writers, including an operator rewind during a tick.
            query = expectedCursor === null
              ? query.is('history_reconcile_cursor', null)
              : query.eq('history_reconcile_cursor', expectedCursor);
            const { data, error } = await query.select('channel_id').maybeSingle();
            if (error || !data) throw new Error(`history checkpoint: ${error?.message ?? 'concurrent cursor change'}`);
            expectedCursor = cursor;
          },
        });
        channelHistoryReconcileStatus.checkedMessages += result.checked;
        channelHistoryReconcileStatus.repairedMessages += repaired;
        if (result.checked > 0 || repaired > 0) {
          console.log('[archivist] channel history reconcile slice', { channelId, ...result, repaired });
        }
        if (!result.caughtUp) allCaughtUp = false;
      }
      if (allCaughtUp) channelHistoryReconcileStatus.lastCompletedAt = new Date().toISOString();
      else delayMs = 15_000;
      channelHistoryReconcileStatus.lastError = null;
      failures = 0;
    } catch (error) {
      failures += 1;
      delayMs = Math.min(900_000, 60_000 * 2 ** Math.min(failures - 1, 4));
      channelHistoryReconcileStatus.lastError = errorMessage(error);
      console.warn('[archivist] channel history reconcile failed; cursor preserved', {
        error: errorMessage(error), retryMs: delayMs,
      });
    } finally {
      channelHistoryReconcileStatus.inProgress = false;
      setHistoryPhase('idle');
      // Schedule only after settling: no overlapping fetches during rate limits.
      setTimeout(() => void tick(), delayMs).unref();
    }
  };
  setTimeout(() => void tick(), 10_000).unref();
};

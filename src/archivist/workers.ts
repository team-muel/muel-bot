import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { config } from '../config.js';
import { ArchiveStore } from './store.js';

type WorkerStatus = {
  running: boolean;
  lastCompletedAt: string | null;
  lastError: string | null;
};

export const backfillStatus: WorkerStatus = {
  running: false,
  lastCompletedAt: null,
  lastError: null,
};

export const attachmentCopyStatus: WorkerStatus = {
  running: false,
  lastCompletedAt: null,
  lastError: null,
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const canFetchMessages = (channel: GuildBasedChannel): channel is GuildTextBasedChannel =>
  channel.isTextBased() && 'messages' in channel;

const collectArchivedThreads = async (
  guild: Guild,
  baseChannels: Iterable<GuildBasedChannel>,
): Promise<GuildBasedChannel[]> => {
  const threads = new Map<string, GuildBasedChannel>();
  try {
    const active = await guild.channels.fetchActiveThreads(false);
    for (const thread of active.threads.values()) threads.set(thread.id, thread);
  } catch (error) {
    console.warn('[archivist] active thread enumeration failed', { error: errorMessage(error) });
  }

  for (const parent of baseChannels) {
    if (!('threads' in parent)) continue;
    const manager = parent.threads as any;
    const kinds: Array<'public' | 'private'> = parent.type === ChannelType.GuildText
      ? ['public', 'private']
      : ['public'];

    for (const type of kinds) {
      let before: Date | undefined;
      for (;;) {
        try {
          const page = await manager.fetchArchived({ type, limit: 100, before }, false);
          const rows = [...page.threads.values()] as GuildBasedChannel[];
          if (rows.length === 0) break;
          for (const thread of rows) threads.set(thread.id, thread);
          const oldest = rows.reduce((a: any, b: any) =>
            (a.archiveTimestamp ?? a.createdTimestamp ?? Infinity)
              < (b.archiveTimestamp ?? b.createdTimestamp ?? Infinity) ? a : b);
          const oldestAt = (oldest as any).archiveTimestamp ?? (oldest as any).createdTimestamp ?? 0;
          if (!page.hasMore || !Number.isFinite(oldestAt) || oldestAt <= 0) break;
          const nextBefore = new Date(oldestAt);
          if (before && nextBefore.getTime() >= before.getTime()) break;
          before = nextBefore;
        } catch (error) {
          console.warn('[archivist] archived thread enumeration failed', {
            guildId: guild.id,
            parentId: parent.id,
            type,
            error: errorMessage(error),
          });
          break;
        }
      }
    }
  }
  return [...threads.values()];
};

const backfillThreadStarter = async (
  store: ArchiveStore,
  channel: GuildBasedChannel,
): Promise<void> => {
  const isPublicStarterThread = channel.type === ChannelType.GuildPublicThread
    || channel.type === ChannelType.GuildNewsThread;
  if (!isPublicStarterThread) return;

  // Do not depend on BaseChannel#isThread() here. Discord forum posts restored
  // from guild channel cache can carry a concrete GuildPublicThread enum while
  // the convenience predicate is not a reliable repair gate. The enum is the
  // protocol-level channel type and is what we persist in archive.channels.
  const thread = channel as ThreadChannel;

  // Public/news/forum threads all have a starter-message concept. Standard
  // text-channel thread starters are usually already present in the parent
  // channel archive, while forum starters live in the post thread itself.
  // The snowflake identity check makes this repair cheap and idempotent.
  if (await store.hasMessage(thread.id)) return;

  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter || !starter.inGuild()) {
      console.warn('[archivist] thread starter message unavailable', {
        channelId: thread.id,
        parentId: thread.parentId,
        type: ChannelType[thread.type] ?? String(thread.type),
      });
      return;
    }
    await store.ingestMessage(starter, 'backfill');
    console.log('[archivist] thread starter recovered', {
      channelId: thread.id,
      starterMessageId: starter.id,
      starterChannelId: starter.channelId,
    });
  } catch (error) {
    // A thread can outlive a deleted starter message. Keep the thread registry
    // and historical backfill usable instead of failing the whole guild crawl.
    console.warn('[archivist] thread starter message recovery failed', {
      channelId: thread.id,
      parentId: thread.parentId,
      type: ChannelType[thread.type] ?? String(thread.type),
      error: errorMessage(error),
    });
  }
};

const repairRegisteredThreadStarters = async (
  client: Client<true>,
  store: ArchiveStore,
): Promise<void> => {
  const missingIds = await store.listMissingPublicThreadStarterIds(100);
  if (missingIds.length === 0) return;

  console.log('[archivist] registered thread starter repair', {
    missing: missingIds.length,
  });

  for (const channelId of missingIds) {
    try {
      const fetched = await client.channels.fetch(channelId);
      if (!fetched || !('guildId' in fetched) || fetched.guildId !== store.guildId) {
        console.warn('[archivist] registered thread unavailable', { channelId });
        continue;
      }
      const channel = fetched as GuildBasedChannel;
      await store.upsertChannel(channel);
      await backfillThreadStarter(store, channel);
    } catch (error) {
      console.warn('[archivist] registered thread starter repair failed', {
        channelId,
        error: errorMessage(error),
      });
    }
  }
};

const backfillChannel = async (
  store: ArchiveStore,
  channel: GuildTextBasedChannel,
): Promise<void> => {
  await store.upsertChannel(channel);

  const state = await store.getChannelBackfillState(channel.id);
  if (state.done) return;
  let cursor = state.cursor ?? undefined;

  for (;;) {
    // discord.js REST owns the rate-limit buckets and automatically sleeps on
    // 429. The runtime logs its rateLimited event so pauses remain observable.
    const page = await channel.messages.fetch({ limit: 100, ...(cursor ? { before: cursor } : {}) });
    const rows = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    if (rows.length === 0) {
      await store.saveChannelBackfillState(channel.id, cursor ?? null, true);
      return;
    }

    await store.ingestBackfillPage(rows);

    const oldest = rows[0];
    cursor = oldest.id;
    const done = page.size < 100;
    await store.saveChannelBackfillState(channel.id, cursor, done);
    console.log('[archivist] backfill page', {
      channelId: channel.id,
      fetched: page.size,
      archived: rows.length,
      cursor,
      done,
    });
    if (done) return;
  }
};

export const runArchiveBackfill = async (client: Client<true>, store: ArchiveStore): Promise<void> => {
  if (!config.archiveBackfillEnabled || backfillStatus.running) return;
  backfillStatus.running = true;
  backfillStatus.lastError = null;
  try {
    const guild = client.guilds.cache.get(store.guildId) ?? await client.guilds.fetch(store.guildId);
    await store.markBackfillStarted();

    // Discord's GUILD_CREATE cache already carries the current channel registry.
    // Persist it before any additional REST enumeration so a throttled Discord
    // REST route cannot block categories/forum parents from becoming queryable.
    const baseChannels: GuildBasedChannel[] = [...guild.channels.cache.values()];
    if (baseChannels.length === 0) {
      const fetched = await guild.channels.fetch();
      for (const channel of fetched.values()) {
        if (channel) baseChannels.push(channel);
      }
    }

    console.log('[archivist] backfill registry', {
      guildId: guild.id,
      cachedChannels: baseChannels.length,
    });

    for (const channel of baseChannels) {
      await store.upsertChannel(channel);

      // Starter recovery belongs to channel-registry discovery, not to the
      // later message-backfill candidate filter. A Discord public/news thread
      // can therefore heal even when canFetchMessages() does not admit the
      // cached channel object into the pagination phase.
      await backfillThreadStarter(store, channel);
    }

    // Historical Forum posts can remain in the database registry while no
    // longer appearing in the ready client's channel cache. Repair those
    // known gaps directly by channel snowflake before broad archived-thread
    // enumeration, which may be slow or throttled.
    await repairRegisteredThreadStarters(client, store);

    // Heal cached/active channels first. This lets active forum posts recover
    // their starter message even if archived-thread enumeration is rate-limited.
    const candidates = new Map<string, GuildTextBasedChannel>();
    for (const channel of baseChannels) {
      if (canFetchMessages(channel)) candidates.set(channel.id, channel);
    }

    let failed = 0;
    for (const channel of candidates.values()) {
      try {
        await backfillChannel(store, channel);
      } catch (error) {
        failed += 1;
        console.warn('[archivist] channel backfill failed; cursor remains resumable', {
          channelId: channel.id,
          error: errorMessage(error),
        });
      }
    }

    // Archived threads require REST enumeration, so keep them out of the
    // critical registry/active-thread repair path.
    const threads = await collectArchivedThreads(guild, baseChannels);
    for (const channel of threads) {
      await store.upsertChannel(channel);
      await backfillThreadStarter(store, channel);

      if (!canFetchMessages(channel) || candidates.has(channel.id)) continue;
      candidates.set(channel.id, channel);
      try {
        await backfillChannel(store, channel);
      } catch (error) {
        failed += 1;
        console.warn('[archivist] archived thread backfill failed; cursor remains resumable', {
          channelId: channel.id,
          error: errorMessage(error),
        });
      }
    }
    if (failed > 0) throw new Error(`${failed} channel(s) failed backfill.`);
    await store.markBackfillCompleted();
    backfillStatus.lastCompletedAt = new Date().toISOString();
  } catch (error) {
    backfillStatus.lastError = errorMessage(error);
    throw error;
  } finally {
    backfillStatus.running = false;
  }
};

const validateDiscordAttachmentUrl = (raw: string): URL => {
  const url = new URL(raw);
  const allowedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new Error(`refusing non-Discord attachment URL host: ${url.hostname}`);
  }
  return url;
};

const safeFilename = (name: string | null, id: number): string =>
  (name?.trim() || `attachment-${id}`).replace(/[\\/\0]/g, '_');

const getObjectClient = (): S3Client | null => {
  if (!config.archiveObjectAccessKey || !config.archiveObjectSecretKey) return null;
  return new S3Client({
    ...(config.archiveObjectEndpoint ? { endpoint: config.archiveObjectEndpoint } : {}),
    region: config.archiveObjectRegion,
    forcePathStyle: config.archiveObjectForcePathStyle,
    credentials: {
      accessKeyId: config.archiveObjectAccessKey,
      secretAccessKey: config.archiveObjectSecretKey,
    },
  });
};

const attachmentIdFromUrl = (url: URL): string | null => {
  const parts = url.pathname.split('/').filter(Boolean);
  const attachmentsAt = parts.indexOf('attachments');
  return attachmentsAt >= 0 && parts.length > attachmentsAt + 2
    ? parts[attachmentsAt + 2]
    : null;
};

const fetchAttachmentBody = async (
  client: Client<true>,
  scope: { guildId: string; channelId: string },
  row: { message_id: string; discord_url: string; filename: string | null },
): Promise<Response> => {
  const initialUrl = validateDiscordAttachmentUrl(row.discord_url);
  let response = await fetch(initialUrl, { signal: AbortSignal.timeout(60_000) });
  if (response.ok) return response;

  // Discord attachment CDN URLs are signed and expire. If the stored URL is
  // stale, refetch the source message to obtain a fresh signed URL before
  // declaring the attachment unrecoverable.
  if (![401, 403, 404].includes(response.status)) {
    throw new Error(`Discord download returned HTTP ${response.status}`);
  }

  const channel = await client.channels.fetch(scope.channelId);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) {
    throw new Error(`cannot refresh attachment URL for non-message channel ${scope.channelId}`);
  }
  const message = await (channel as GuildTextBasedChannel).messages.fetch(row.message_id);
  const attachmentId = attachmentIdFromUrl(initialUrl);
  const refreshedAttachment = (attachmentId ? message.attachments.get(attachmentId) : null)
    ?? [...message.attachments.values()].find((attachment) => attachment.name === row.filename)
    ?? null;
  if (!refreshedAttachment) {
    throw new Error('attachment no longer exists on the source Discord message');
  }

  const refreshedUrl = validateDiscordAttachmentUrl(refreshedAttachment.url);
  response = await fetch(refreshedUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Discord refreshed download returned HTTP ${response.status}`);
  return response;
};

const copyAttachmentBatch = async (
  client: Client<true>,
  store: ArchiveStore,
  objectClient: S3Client,
): Promise<number> => {
  const rows = await store.listUncopiedAttachments();
  for (const row of rows) {
    try {
      const scope = await store.getAttachmentMessageScope(row.message_id);
      if (!scope || scope.guildId !== store.guildId) continue;
      const response = await fetchAttachmentBody(client, scope, row);
      const body = Buffer.from(await response.arrayBuffer());
      const objectKey = `${scope.guildId}/${scope.channelId}/${row.message_id}/${row.id}-${safeFilename(row.filename, row.id)}`;
      await objectClient.send(new PutObjectCommand({
        Bucket: config.archiveObjectBucket,
        Key: objectKey,
        Body: body,
        ContentType: row.content_type ?? response.headers.get('content-type') ?? undefined,
        ContentLength: body.length,
      }));
      await store.markAttachmentCopied(row.id, objectKey);
    } catch (error) {
      console.warn('[archivist] attachment copy failed', { attachmentId: row.id, error: errorMessage(error) });
    }
  }
  return rows.length;
};

export const startAttachmentCopyWorker = (client: Client<true>, store: ArchiveStore): void => {
  const objectClient = getObjectClient();
  if (!objectClient || attachmentCopyStatus.running) {
    if (!objectClient) attachmentCopyStatus.lastError = 'Archive object storage credentials are not configured.';
    return;
  }
  attachmentCopyStatus.running = true;
  attachmentCopyStatus.lastError = null;

  const tick = async () => {
    try {
      await copyAttachmentBatch(client, store, objectClient);
      attachmentCopyStatus.lastCompletedAt = new Date().toISOString();
      attachmentCopyStatus.lastError = null;
    } catch (error) {
      attachmentCopyStatus.lastError = errorMessage(error);
      console.warn('[archivist] attachment worker tick failed', { error: attachmentCopyStatus.lastError });
    } finally {
      setTimeout(tick, Math.max(5_000, config.archiveAttachmentCopyIntervalMs)).unref();
    }
  };
  void tick();
};

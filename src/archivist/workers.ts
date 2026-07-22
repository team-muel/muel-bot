import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Message,
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

    for (const message of rows) await store.ingestMessage(message, 'backfill');

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
    const guild = await client.guilds.fetch(store.guildId);
    await store.markBackfillStarted();
    const fetched = await guild.channels.fetch();
    const baseChannels: GuildBasedChannel[] = [];
    for (const channel of fetched.values()) {
      if (channel) baseChannels.push(channel);
    }
    const threads = await collectArchivedThreads(guild, baseChannels);
    const candidates = new Map<string, GuildTextBasedChannel>();
    for (const channel of [...baseChannels, ...threads]) {
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
  if (!config.ncpAccessKey || !config.ncpSecretKey) return null;
  return new S3Client({
    endpoint: config.ncpObjectEndpoint,
    region: 'kr-standard',
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.ncpAccessKey,
      secretAccessKey: config.ncpSecretKey,
    },
  });
};

const copyAttachmentBatch = async (store: ArchiveStore, objectClient: S3Client): Promise<number> => {
  const rows = await store.listUncopiedAttachments();
  for (const row of rows) {
    try {
      const scope = await store.getAttachmentMessageScope(row.message_id);
      if (!scope || scope.guildId !== store.guildId) continue;
      const url = validateDiscordAttachmentUrl(row.discord_url);
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Discord download returned HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const objectKey = `${scope.guildId}/${scope.channelId}/${row.message_id}/${safeFilename(row.filename, row.id)}`;
      await objectClient.send(new PutObjectCommand({
        Bucket: config.ncpObjectBucket,
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

export const startAttachmentCopyWorker = (store: ArchiveStore): void => {
  const objectClient = getObjectClient();
  if (!objectClient || attachmentCopyStatus.running) {
    if (!objectClient) attachmentCopyStatus.lastError = 'NCP object storage credentials are not configured.';
    return;
  }
  attachmentCopyStatus.running = true;
  attachmentCopyStatus.lastError = null;

  const tick = async () => {
    try {
      await copyAttachmentBatch(store, objectClient);
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

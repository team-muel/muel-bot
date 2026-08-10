import type { Client, GuildMember, Message, PartialGuildMember, PartialMessage } from 'discord.js';
import { config } from '../config.js';
import { ArchiveStore } from './store.js';
import {
  attachmentCopyStatus,
  backfillStatus,
  runArchiveBackfill,
  startAttachmentCopyWorker,
} from './workers.js';
import {
  getSupabaseRestrictionStatus,
  isSupabaseDataApiProbeDue,
  isSupabaseDataApiRestricted,
  observeSupabaseDataApiError,
  recordSupabaseDataApiSuccess,
} from '../serviceRestriction.js';

let store: ArchiveStore | null = null;
let ready = false;
let starting = false;
let lastError: string | null = null;
let lastAttemptAt: string | null = null;
let retryTimer: NodeJS.Timeout | null = null;

const RETRY_INTERVAL_MS = 60_000;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const getArchivistStatus = () => ({
  enabled: Boolean(config.ownedGuildId),
  ready,
  starting,
  guildIdConfigured: Boolean(config.ownedGuildId),
  lastError,
  lastAttemptAt,
  retryScheduled: Boolean(retryTimer),
  backfill: { ...backfillStatus },
  attachmentCopy: { ...attachmentCopyStatus },
});

export const startArchivist = async (client: Client<true>): Promise<void> => {
  if (!config.ownedGuildId) return;
  if (!retryTimer) {
    retryTimer = setInterval(() => {
      void startArchivist(client);
    }, RETRY_INTERVAL_MS);
    retryTimer.unref();
  }
  if (ready || starting) return;
  if (isSupabaseDataApiRestricted() && !isSupabaseDataApiProbeDue()) {
    const restriction = getSupabaseRestrictionStatus();
    lastError = `waiting for Supabase Data API recovery: ${restriction.reason ?? 'restricted'}`;
    return;
  }

  starting = true;
  lastAttemptAt = new Date().toISOString();
  try {
    store = new ArchiveStore();
    await store.assertReady();
    recordSupabaseDataApiSuccess();
    ready = true;
    lastError = null;
    client.rest.on('rateLimited', (info) => {
      console.warn('[archivist] Discord REST rate limited; discord.js will back off', {
        route: info.route,
        retryAfterMs: info.retryAfter,
        global: info.global,
      });
    });
    startAttachmentCopyWorker(store);
    void runArchiveBackfill(client, store).catch((error) => {
      console.warn('[archivist] backfill stopped', { error: errorMessage(error) });
    });
    console.log('[archivist] ready', { guildId: store.guildId });
  } catch (error) {
    observeSupabaseDataApiError(error);
    ready = false;
    store = null;
    lastError = errorMessage(error);
    console.error('[archivist] disabled after preflight failure', { error: lastError });
  } finally {
    starting = false;
  }
};

export const archiveMessageCreate = async (message: Message): Promise<void> => {
  if (!store || !store.owns(message.guildId) || !message.inGuild()) return;
  await store.ingestMessage(message, 'stream');
};

export const archiveMessageUpdate = async (_oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> => {
  if (!store || !store.owns(newMessage.guildId)) return;
  const complete = newMessage.partial ? await newMessage.fetch() : newMessage;
  if (!complete.inGuild()) return;
  await store.captureMessageUpdate(complete);
};

export const archiveMessageDelete = async (message: Message | PartialMessage): Promise<void> => {
  if (!store || !store.owns(message.guildId)) return;
  await store.markMessageDeleted(message.id);
};

export const archiveMemberRemove = async (member: GuildMember | PartialGuildMember): Promise<void> => {
  if (!store || !store.owns(member.guild.id)) return;
  await store.softMask(member);
};

export const archiveMemberAdd = async (member: GuildMember): Promise<void> => {
  if (!store || !store.owns(member.guild.id)) return;
  await store.restoreSoftMaskedAuthor(member);
};

export const getArchiveOnboardingNotice = (guildId: string): string | null =>
  config.ownedGuildId === guildId
    ? '이 서버의 기록 보존과 마스킹 정책은 `/정책`에서 확인할 수 있어.'
    : null;

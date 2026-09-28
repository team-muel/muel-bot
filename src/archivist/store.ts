import {
  ChannelType,
  MessageType,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type PartialGuildMember,
} from 'discord.js';
import { config } from '../config.js';
import { getSupabaseClient } from '../supabase.js';
import {
  decodeArchiveKey,
  decryptIdentity,
  deriveAuthorIdentity,
  encryptIdentity,
  fromPostgresBytea,
  toPostgresBytea,
} from './crypto.js';

type ArchiveSource = 'backfill' | 'stream';

type AuthorRow = {
  author_ref: string;
  mask_state: 'active' | 'soft' | 'hard';
  identity_enc: unknown;
};

type AttachmentRow = {
  id: number;
  message_id: string;
  discord_url: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

const requireValue = (name: string, value: string | null): string => {
  if (!value) throw new Error(`${name} is required when OWNED_GUILD_ID is set.`);
  return value;
};

const throwIfError = (label: string, error: { message: string; code?: string } | null) => {
  if (!error) return;
  const hint = error.code === 'PGRST106'
    ? ' Add archive to Supabase Data API exposed schemas and grant service_role access.'
    : '';
  throw new Error(`${label}: ${error.message}.${hint}`);
};

const collectComponentText = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectComponentText(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const record = value as Record<string, unknown>;
  for (const key of ['content', 'title', 'description', 'label', 'name']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) out.push(candidate.trim());
  }
  for (const key of ['components', 'accessory', 'items', 'fields']) {
    if (key in record) collectComponentText(record[key], out);
  }
  return out;
};

const componentJson = (component: unknown): Record<string, unknown> => {
  if (component && typeof component === 'object' && 'toJSON' in component
      && typeof (component as { toJSON?: unknown }).toJSON === 'function') {
    return ((component as { toJSON: () => unknown }).toJSON() ?? {}) as Record<string, unknown>;
  }
  return (component ?? {}) as Record<string, unknown>;
};

export class ArchiveStore {
  readonly guildId: string;
  private readonly salt: string;
  private readonly encryptionKey: Buffer;
  private readonly db;
  private readonly backfillAuthorCache = new Map<string, string>();
  private readonly editQueues = new Map<string, Promise<void>>();

  constructor() {
    this.guildId = requireValue('OWNED_GUILD_ID', config.ownedGuildId);
    this.salt = requireValue('ARCHIVE_SALT', config.archiveSalt);
    this.encryptionKey = decodeArchiveKey(requireValue('ARCHIVE_ENC_KEY', config.archiveEncKey));
    this.db = getSupabaseClient().schema('archive');
  }

  async assertReady(): Promise<void> {
    const { data, error } = await this.db
      .from('guilds')
      .select('guild_id')
      .eq('guild_id', this.guildId)
      .maybeSingle();
    throwIfError('archive preflight failed', error);
    if (!data) {
      throw new Error(`archive preflight failed: guild ${this.guildId} is not allowlisted in archive.guilds.`);
    }
  }

  owns(guildId: string | null | undefined): boolean {
    return guildId === this.guildId;
  }

  async upsertChannel(channel: GuildBasedChannel): Promise<void> {
    if (!this.owns(channel.guildId)) return;
    const parentId = 'parentId' in channel ? channel.parentId : null;
    const { error } = await this.db.from('channels').upsert({
      channel_id: channel.id,
      guild_id: channel.guildId,
      name: 'name' in channel ? channel.name : null,
      type: ChannelType[channel.type] ?? String(channel.type),
      parent_id: parentId,
      is_archived: channel.isThread() ? Boolean(channel.archived) : false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'channel_id' });
    throwIfError(`channel upsert failed (${channel.id})`, error);
  }

  private async upsertAuthor(message: Message<true>, source: ArchiveSource): Promise<string> {
    const cacheKey = `${message.guildId}:${message.author.id}`;
    if (source === 'backfill') {
      const cached = this.backfillAuthorCache.get(cacheKey);
      if (cached) return cached;
    }

    const { authorKey, pseudonym } = deriveAuthorIdentity(this.salt, message.guildId, message.author.id);
    const { data: existing, error: selectError } = await this.db
      .from('authors')
      .select('author_ref, mask_state, identity_enc')
      .eq('guild_id', message.guildId)
      .eq('author_key', authorKey)
      .maybeSingle();
    throwIfError(`author lookup failed (${message.author.id})`, selectError);

    // A soft/hard-masked identity must never be silently reidentified by a
    // late message or a rerun of the historical backfill. GuildMemberAdd is
    // the only restoration path, and only the soft state is reversible.
    if (existing && existing.mask_state !== 'active') {
      return (existing as AuthorRow).author_ref;
    }

    const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    const avatar = message.member?.displayAvatarURL() ?? message.author.displayAvatarURL();
    const identityEnc = toPostgresBytea(encryptIdentity({
      userId: message.author.id,
      displayName,
      avatar,
    }, this.encryptionKey));

    const { data, error } = await this.db.from('authors').upsert({
      guild_id: message.guildId,
      author_key: authorKey,
      pseudonym,
      display_name: displayName,
      avatar_url: avatar,
      is_bot: message.author.bot,
      identity_enc: identityEnc,
      mask_state: 'active',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'guild_id,author_key' })
      .select('author_ref')
      .single();
    throwIfError(`author upsert failed (${message.author.id})`, error);
    if (!data) throw new Error(`author upsert returned no row (${message.author.id}).`);
    const authorRef = String(data.author_ref);
    if (source === 'backfill') this.backfillAuthorCache.set(cacheKey, authorRef);
    return authorRef;
  }

  async ingestMessage(message: Message<true>, source: ArchiveSource): Promise<void> {
    if (!this.owns(message.guildId)) return;
    await this.upsertChannel(message.channel);
    const authorRef = await this.upsertAuthor(message, source);
    const { data: existing, error: existingError } = await this.db
      .from('messages')
      .select('source, tombstoned')
      .eq('message_id', message.id)
      .maybeSingle();
    throwIfError(`message lookup failed (${message.id})`, existingError);

    // Never let a resumed snapshot overwrite newer stream state or explicit
    // erasure. This matters when backfill and gateway ingestion overlap.
    const preserveExisting = Boolean(existing?.tombstoned)
      || (source === 'backfill' && existing?.source === 'stream');

    if (!preserveExisting) {
      const { error } = await this.db.from('messages').upsert({
        message_id: message.id,
        channel_id: message.channelId,
        guild_id: message.guildId,
        author_ref: authorRef,
        content: message.content || null,
        created_at: message.createdAt.toISOString(),
        edited_at: message.editedAt?.toISOString() ?? null,
        reply_to_message_id: message.reference?.messageId ?? null,
        msg_type: MessageType[message.type] ?? String(message.type),
        has_attachments: message.attachments.size > 0,
        meta: {
          pinned: message.pinned,
          system: message.system,
          webhook_id: message.webhookId,
          flags: message.flags.bitfield.toString(),
        },
        source,
      }, { onConflict: 'message_id' });
      throwIfError(`message upsert failed (${message.id})`, error);
    }

    await this.ingestAttachments(message);
    await this.replaceMessageRichPayload(message);
  }

  /**
   * Backfill is page-oriented, so persist a Discord page in a handful of
   * PostgREST requests instead of doing two or three network round trips per
   * message. Stream events still use ingestMessage for their single-row
   * ordering and edit protection.
   */
  async ingestBackfillPage(messages: Message<true>[]): Promise<void> {
    if (messages.length === 0) return;
    const owned = messages.filter((message) => this.owns(message.guildId));
    if (owned.length === 0) return;
    await this.upsertChannel(owned[0].channel);

    const authorRefs = new Map<string, string>();
    for (const message of owned) {
      if (authorRefs.has(message.author.id)) continue;
      authorRefs.set(message.author.id, await this.upsertAuthor(message, 'backfill'));
    }

    const messageIds = owned.map((message) => message.id);
    const { data: existingRows, error: existingError } = await this.db
      .from('messages')
      .select('message_id, source, tombstoned')
      .in('message_id', messageIds);
    throwIfError('backfill page message lookup failed', existingError);
    const existing = new Map((existingRows ?? []).map((row: any) => [String(row.message_id), row]));

    const rows = owned.flatMap((message) => {
      const current = existing.get(message.id) as { source?: string; tombstoned?: boolean } | undefined;
      if (current?.tombstoned || current?.source === 'stream') return [];
      return [{
        message_id: message.id,
        channel_id: message.channelId,
        guild_id: message.guildId,
        author_ref: authorRefs.get(message.author.id),
        content: message.content || null,
        created_at: message.createdAt.toISOString(),
        edited_at: message.editedAt?.toISOString() ?? null,
        reply_to_message_id: message.reference?.messageId ?? null,
        msg_type: MessageType[message.type] ?? String(message.type),
        has_attachments: message.attachments.size > 0,
        meta: {
          pinned: message.pinned,
          system: message.system,
          webhook_id: message.webhookId,
          flags: message.flags.bitfield.toString(),
        },
        source: 'backfill' as const,
      }];
    });
    if (rows.length > 0) {
      const { error } = await this.db.from('messages').upsert(rows, { onConflict: 'message_id' });
      throwIfError('backfill page message upsert failed', error);
    }

    await this.replaceBackfillPageRichPayload(owned);

    const candidates = owned.flatMap((message) => [...message.attachments.values()].map((attachment) => ({
      message_id: message.id,
      discord_url: attachment.url,
      filename: attachment.name,
      content_type: attachment.contentType,
      size_bytes: attachment.size,
    })));
    if (candidates.length === 0) return;
    const { data: existingAttachments, error: attachmentLookupError } = await this.db
      .from('attachments')
      .select('message_id, discord_url')
      .in('message_id', messageIds);
    throwIfError('backfill page attachment lookup failed', attachmentLookupError);
    const seen = new Set((existingAttachments ?? []).map((row: any) => `${row.message_id}\0${row.discord_url}`));
    const missing = candidates.filter((row) => !seen.has(`${row.message_id}\0${row.discord_url}`));
    if (missing.length > 0) {
      const { error } = await this.db.from('attachments').insert(missing);
      throwIfError('backfill page attachment insert failed', error);
    }
  }

  private serializeEmbed(messageId: string, embedIndex: number, embed: Message<true>['embeds'][number]) {
    const raw = embed.toJSON();
    return {
      message_id: messageId,
      embed_index: embedIndex,
      embed_type: raw.type ?? null,
      title: raw.title ?? null,
      description: raw.description ?? null,
      url: raw.url ?? null,
      color: raw.color ?? null,
      embed_timestamp: raw.timestamp ?? null,
      author: raw.author ?? null,
      footer: raw.footer ?? null,
      fields: raw.fields ?? [],
      image: raw.image ?? null,
      thumbnail: raw.thumbnail ?? null,
      video: raw.video ?? null,
      provider: raw.provider ?? null,
      raw,
      updated_at: new Date().toISOString(),
    };
  }

  private serializeComponent(messageId: string, componentIndex: number, component: unknown) {
    const raw = componentJson(component);
    const projected = [...new Set(collectComponentText(raw))].join('\n').trim();
    return {
      message_id: messageId,
      component_index: componentIndex,
      component_type: Number(raw.type ?? -1),
      text_projection: projected || null,
      raw,
      updated_at: new Date().toISOString(),
    };
  }

  private projectRichText(message: Message<true>): string {
    const parts: string[] = [];
    if (message.content?.trim()) parts.push(message.content.trim());
    for (const embed of message.embeds) {
      const raw = embed.toJSON();
      if (raw.title?.trim()) parts.push(raw.title.trim());
      if (raw.description?.trim()) parts.push(raw.description.trim());
      for (const field of raw.fields ?? []) {
        if (field.name?.trim()) parts.push(field.name.trim());
        if (field.value?.trim()) parts.push(field.value.trim());
      }
      if (raw.footer?.text?.trim()) parts.push(raw.footer.text.trim());
      if (raw.author?.name?.trim()) parts.push(raw.author.name.trim());
    }
    for (const component of message.components as readonly unknown[]) {
      parts.push(...collectComponentText(componentJson(component)));
    }
    return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join('\n').trim();
  }

  private async replaceMessageRichPayload(message: Message<true>): Promise<void> {
    const [embedDelete, componentDelete] = await Promise.all([
      this.db.from('message_embeds').delete().eq('message_id', message.id),
      this.db.from('message_components').delete().eq('message_id', message.id),
    ]);
    throwIfError(`message embed delete failed (${message.id})`, embedDelete.error);
    throwIfError(`message component delete failed (${message.id})`, componentDelete.error);

    const embedRows = message.embeds.map((embed, index) => this.serializeEmbed(message.id, index, embed));
    if (embedRows.length > 0) {
      const { error } = await this.db.from('message_embeds').insert(embedRows);
      throwIfError(`message embed insert failed (${message.id})`, error);
    }

    const componentRows = [...(message.components as readonly unknown[])]
      .map((component, index) => this.serializeComponent(message.id, index, component));
    if (componentRows.length > 0) {
      const { error } = await this.db.from('message_components').insert(componentRows);
      throwIfError(`message component insert failed (${message.id})`, error);
    }

    const { error: richError } = await this.db.from('message_rich_text').upsert({
      message_id: message.id,
      rendered_text: this.projectRichText(message),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'message_id' });
    throwIfError(`message rich text upsert failed (${message.id})`, richError);
  }

  private async replaceBackfillPageRichPayload(messages: Message<true>[]): Promise<{ embeds: number; components: number }> {
    if (messages.length === 0) return { embeds: 0, components: 0 };
    const messageIds = messages.map((message) => message.id);
    const { data: archivedRows, error: archiveLookupError } = await this.db.from('messages')
      .select('message_id,tombstoned')
      .in('message_id', messageIds);
    throwIfError('rich reconcile archive message lookup failed', archiveLookupError);

    const archivedIds = new Set((archivedRows ?? [])
      .filter((row: any) => !row.tombstoned)
      .map((row: any) => String(row.message_id)));
    const archivedMessages = messages.filter((message) => archivedIds.has(message.id));
    if (archivedMessages.length === 0) return { embeds: 0, components: 0 };

    const archivedMessageIds = archivedMessages.map((message) => message.id);
    const [embedDelete, componentDelete] = await Promise.all([
      this.db.from('message_embeds').delete().in('message_id', archivedMessageIds),
      this.db.from('message_components').delete().in('message_id', archivedMessageIds),
    ]);
    throwIfError('backfill page embed delete failed', embedDelete.error);
    throwIfError('backfill page component delete failed', componentDelete.error);

    const embedRows = archivedMessages.flatMap((message) =>
      message.embeds.map((embed, index) => this.serializeEmbed(message.id, index, embed)));
    const componentRows = archivedMessages.flatMap((message) =>
      [...(message.components as readonly unknown[])].map((component, index) =>
        this.serializeComponent(message.id, index, component)));
    const richRows = archivedMessages.map((message) => ({
      message_id: message.id,
      rendered_text: this.projectRichText(message),
      updated_at: new Date().toISOString(),
    }));

    if (embedRows.length > 0) {
      const { error } = await this.db.from('message_embeds').insert(embedRows);
      throwIfError('backfill page embed insert failed', error);
    }
    if (componentRows.length > 0) {
      const { error } = await this.db.from('message_components').insert(componentRows);
      throwIfError('backfill page component insert failed', error);
    }
    const { error: richError } = await this.db.from('message_rich_text')
      .upsert(richRows, { onConflict: 'message_id' });
    throwIfError('backfill page rich text upsert failed', richError);

    return { embeds: embedRows.length, components: componentRows.length };
  }

  async ingestEmbedBackfillPage(messages: Message<true>[]): Promise<{ embeds: number; components: number }> {
    const owned = messages.filter((message) => this.owns(message.guildId));
    if (owned.length === 0) return { embeds: 0, components: 0 };
    return this.replaceBackfillPageRichPayload(owned);
  }

  async listMissingComponentsV2MessageIds(channelId: string, limit = 50): Promise<string[]> {
    const { data: rows, error } = await this.db.from('messages')
      .select('message_id,meta')
      .eq('guild_id', this.guildId)
      .eq('channel_id', channelId)
      .eq('tombstoned', false)
      .order('created_at', { ascending: false })
      .limit(1000);
    throwIfError(`Components V2 candidate lookup failed (${channelId})`, error);

    const candidates = (rows ?? []).flatMap((row: any) => {
      const rawFlags = row.meta && typeof row.meta === 'object' ? row.meta.flags : null;
      const flags = BigInt(String(rawFlags ?? '0'));
      return (flags & 32768n) !== 0n ? [String(row.message_id)] : [];
    });
    if (candidates.length === 0) return [];

    const { data: existing, error: existingError } = await this.db.from('message_components')
      .select('message_id')
      .in('message_id', candidates);
    throwIfError(`Components V2 existence lookup failed (${channelId})`, existingError);
    const existingIds = new Set((existing ?? []).map((row: any) => String(row.message_id)));
    return candidates.filter((messageId) => !existingIds.has(messageId)).slice(0, limit);
  }

  async listEmbedReconcileChannels(limit = 1): Promise<Array<{ channelId: string; cursor: string | null }>> {
    const { data, error } = await this.db.from('channels')
      .select('channel_id, embed_reconcile_cursor')
      .eq('guild_id', this.guildId)
      .not('embed_reconcile_requested_at', 'is', null)
      .lt('embed_reconcile_version', 1)
      .order('updated_at', { ascending: true })
      .limit(limit);
    throwIfError('archive rich reconcile queue query failed', error);
    return (data ?? []).map((row: any) => ({
      channelId: String(row.channel_id),
      cursor: row.embed_reconcile_cursor ? String(row.embed_reconcile_cursor) : null,
    }));
  }

  async saveEmbedReconcileState(
    channelId: string,
    cursor: string | null,
    done: boolean,
  ): Promise<void> {
    const { error } = await this.db.from('channels').update({
      embed_reconcile_cursor: cursor,
      embed_reconcile_version: done ? 1 : 0,
      embed_reconciled_at: done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('channel_id', channelId);
    throwIfError(`rich reconcile state update failed (${channelId})`, error);
  }

  private async ingestAttachments(message: Message<true>): Promise<void> {
    for (const attachment of message.attachments.values()) {
      const { data: prior, error: priorError } = await this.db
        .from('attachments')
        .select('id')
        .eq('message_id', message.id)
        .eq('discord_url', attachment.url)
        .limit(1)
        .maybeSingle();
      throwIfError(`attachment lookup failed (${attachment.id})`, priorError);
      if (prior) continue;
      const { error } = await this.db.from('attachments').insert({
        message_id: message.id,
        discord_url: attachment.url,
        filename: attachment.name,
        content_type: attachment.contentType,
        size_bytes: attachment.size,
      });
      throwIfError(`attachment insert failed (${attachment.id})`, error);
    }
  }

  captureMessageUpdate(message: Message<true>): Promise<void> {
    if (!this.owns(message.guildId)) return Promise.resolve();
    const previous = this.editQueues.get(message.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const { data: current, error } = await this.db
        .from('messages')
        .select('content, tombstoned')
        .eq('message_id', message.id)
        .maybeSingle();
      throwIfError(`message edit lookup failed (${message.id})`, error);
      if (!current) {
        await this.ingestMessage(message, 'stream');
        return;
      }
      if (current.tombstoned) return;
      if (current.content === (message.content || null)) {
        // Components V2 and embeds can change while legacy content remains null
        // or unchanged, so refresh the rich payload on every message update.
        await this.ingestAttachments(message);
        await this.replaceMessageRichPayload(message);
        return;
      }

      const editedAt = message.editedAt?.toISOString() ?? new Date().toISOString();
      const { error: versionError } = await this.db.from('message_versions').insert({
        message_id: message.id,
        content: current.content,
        version_at: editedAt,
        captured_via: 'stream',
      });
      throwIfError(`message version insert failed (${message.id})`, versionError);
      const { error: updateError } = await this.db.from('messages').update({
        content: message.content || null,
        edited_at: editedAt,
        has_attachments: message.attachments.size > 0,
        source: 'stream',
      }).eq('message_id', message.id);
      throwIfError(`message edit update failed (${message.id})`, updateError);
      await this.ingestAttachments(message);
      await this.replaceMessageRichPayload(message);
    });
    const tracked = next.finally(() => {
      if (this.editQueues.get(message.id) === tracked) this.editQueues.delete(message.id);
    });
    this.editQueues.set(message.id, tracked);
    return tracked;
  }

  async markMessageDeleted(messageId: string): Promise<void> {
    const { data, error } = await this.db
      .from('messages')
      .select('meta')
      .eq('message_id', messageId)
      .maybeSingle();
    throwIfError(`message delete lookup failed (${messageId})`, error);
    if (!data) return;
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    const { error: updateError } = await this.db.from('messages').update({
      meta: { ...meta, deleted_at: new Date().toISOString() },
    }).eq('message_id', messageId);
    throwIfError(`message delete marker failed (${messageId})`, updateError);
  }

  async tombstoneMessage(messageId: string, reason = 'erasure_request'): Promise<void> {
    const { error } = await this.db.rpc('tombstone_message', {
      p_message_id: messageId,
      p_reason: reason,
    });
    throwIfError(`message tombstone RPC failed (${messageId})`, error);
  }

  async softMask(member: GuildMember | PartialGuildMember): Promise<void> {
    if (!this.owns(member.guild.id)) return;
    const { authorKey } = deriveAuthorIdentity(this.salt, member.guild.id, member.id);
    const { data, error } = await this.db.from('authors')
      .select('author_ref, mask_state')
      .eq('guild_id', member.guild.id)
      .eq('author_key', authorKey)
      .maybeSingle();
    throwIfError(`soft-mask lookup failed (${member.id})`, error);
    if (!data || data.mask_state !== 'active') return;
    const { error: rpcError } = await this.db.rpc('apply_soft_mask', { p_author_ref: data.author_ref });
    throwIfError(`soft-mask RPC failed (${member.id})`, rpcError);
    this.backfillAuthorCache.delete(`${member.guild.id}:${member.id}`);
  }

  async restoreSoftMaskedAuthor(member: GuildMember): Promise<void> {
    if (!this.owns(member.guild.id)) return;
    const { authorKey } = deriveAuthorIdentity(this.salt, member.guild.id, member.id);
    const { data, error } = await this.db.from('authors')
      .select('author_ref, mask_state, identity_enc')
      .eq('guild_id', member.guild.id)
      .eq('author_key', authorKey)
      .maybeSingle();
    throwIfError(`restore lookup failed (${member.id})`, error);
    if (!data || data.mask_state !== 'soft' || !data.identity_enc) return;

    // Authentication failure here means the configured key changed or the
    // ciphertext was damaged. Do not overwrite the masked identity in either case.
    decryptIdentity(fromPostgresBytea(data.identity_enc), this.encryptionKey);
    const displayName = member.displayName ?? member.user.globalName ?? member.user.username;
    const avatar = member.displayAvatarURL();
    const { error: rpcError } = await this.db.rpc('restore_author', {
      p_author_ref: data.author_ref,
      p_display: displayName,
      p_avatar: avatar,
    });
    throwIfError(`restore RPC failed (${member.id})`, rpcError);
  }

  async markBackfillStarted(): Promise<void> {
    const { error } = await this.db.from('guilds').update({
      backfill_started_at: new Date().toISOString(),
    }).eq('guild_id', this.guildId).is('backfill_started_at', null);
    throwIfError('guild backfill start update failed', error);
  }

  async markBackfillCompleted(): Promise<void> {
    const { error } = await this.db.from('guilds').update({
      backfill_completed_at: new Date().toISOString(),
    }).eq('guild_id', this.guildId);
    throwIfError('guild backfill completion update failed', error);
  }

  async hasMessage(messageId: string): Promise<boolean> {
    const { data, error } = await this.db.from('messages')
      .select('message_id')
      .eq('message_id', messageId)
      .maybeSingle();
    throwIfError(`archive message existence check failed (${messageId})`, error);
    return Boolean(data);
  }

  async listMissingPublicThreadStarterIds(limit = 100): Promise<string[]> {
    const { data: channels, error: channelError } = await this.db.from('channels')
      .select('channel_id')
      .eq('guild_id', this.guildId)
      .in('type', ['GuildPublicThread', 'GuildNewsThread'])
      .order('updated_at', { ascending: false })
      .limit(1000);
    throwIfError('archive public thread registry query failed', channelError);

    const ids = (channels ?? []).map((row: any) => String(row.channel_id));
    if (ids.length === 0) return [];

    const existing = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const { data: rows, error } = await this.db.from('messages')
        .select('message_id')
        .in('message_id', chunk);
      throwIfError('archive thread starter existence query failed', error);
      for (const row of rows ?? []) existing.add(String(row.message_id));
    }

    return ids.filter((id) => !existing.has(id)).slice(0, limit);
  }

  async listThreadsNeedingHistoryReconcile(limit = 6): Promise<Array<{ channelId: string; cursor: string | null }>> {
    const { data, error } = await this.db.from('channels')
      .select('channel_id, history_reconcile_cursor')
      .eq('guild_id', this.guildId)
      .in('type', ['GuildPublicThread', 'GuildNewsThread'])
      .lt('history_reconcile_version', 1)
      .order('updated_at', { ascending: false })
      .limit(limit);
    throwIfError('archive thread history reconcile query failed', error);
    return (data ?? []).map((row: any) => ({
      channelId: String(row.channel_id),
      cursor: row.history_reconcile_cursor ? String(row.history_reconcile_cursor) : null,
    }));
  }

  async saveThreadHistoryReconcileState(
    channelId: string,
    cursor: string | null,
    done: boolean,
  ): Promise<void> {
    const { error } = await this.db.from('channels').update({
      history_reconcile_cursor: cursor,
      history_reconcile_version: done ? 1 : 0,
      history_reconciled_at: done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('channel_id', channelId);
    throwIfError(`thread history reconcile state update failed (${channelId})`, error);
  }

  async getChannelBackfillState(channelId: string): Promise<{ cursor: string | null; done: boolean }> {
    const { data, error } = await this.db.from('channels')
      .select('last_backfilled_message_id, backfill_done')
      .eq('channel_id', channelId)
      .single();
    throwIfError(`channel backfill state failed (${channelId})`, error);
    if (!data) throw new Error(`channel backfill state returned no row (${channelId}).`);
    return { cursor: data.last_backfilled_message_id, done: Boolean(data.backfill_done) };
  }

  async saveChannelBackfillState(channelId: string, cursor: string | null, done: boolean): Promise<void> {
    const { error } = await this.db.from('channels').update({
      last_backfilled_message_id: cursor,
      backfill_done: done,
      updated_at: new Date().toISOString(),
    }).eq('channel_id', channelId);
    throwIfError(`channel backfill cursor update failed (${channelId})`, error);
  }

  async listUncopiedAttachments(limit = 25): Promise<AttachmentRow[]> {
    const { data, error } = await this.db.from('attachments')
      .select('id, message_id, discord_url, filename, content_type, size_bytes')
      .is('stored_object_key', null)
      .order('id', { ascending: true })
      .limit(limit);
    throwIfError('uncopied attachment query failed', error);
    return (data ?? []) as AttachmentRow[];
  }

  async getAttachmentMessageScope(messageId: string): Promise<{ guildId: string; channelId: string } | null> {
    const { data, error } = await this.db.from('messages')
      .select('guild_id, channel_id')
      .eq('message_id', messageId)
      .maybeSingle();
    throwIfError(`attachment message lookup failed (${messageId})`, error);
    return data ? { guildId: data.guild_id, channelId: data.channel_id } : null;
  }

  async markAttachmentCopied(id: number, objectKey: string): Promise<void> {
    const { error } = await this.db.from('attachments').update({
      stored_object_key: objectKey,
      copied_at: new Date().toISOString(),
    }).eq('id', id).is('stored_object_key', null);
    throwIfError(`attachment copy update failed (${id})`, error);
  }
}

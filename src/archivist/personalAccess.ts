import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { getSupabaseClient } from '../supabase.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_BODY_BYTES = 1024 * 1024;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

let rateWindowStartedAt = Date.now();
let requestsInWindow = 0;

type ArchiveFilters = {
  channelId?: string;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
};

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const safeEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const isAuthorized = (request: IncomingMessage): boolean => {
  if (!config.archivePersonalToken || !config.ownedGuildId) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7).trim(), config.archivePersonalToken);
};

const withinRateLimit = (): boolean => {
  const now = Date.now();
  if (now - rateWindowStartedAt >= RATE_WINDOW_MS) {
    rateWindowStartedAt = now;
    requestsInWindow = 0;
  }
  requestsInWindow += 1;
  return requestsInWindow <= RATE_LIMIT;
};

const requiredGuildId = (): string => {
  if (!config.ownedGuildId) throw new Error('Archive personal access is not configured.');
  return config.ownedGuildId;
};

const archiveDb = () => getSupabaseClient().schema('archive');

const normalizeLimit = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
};

const normalizeDate = (value: string | null | undefined, field: string): string | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be an ISO-8601 date.`);
  return parsed.toISOString();
};

const normalizeSearchTerm = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 200) {
    throw new Error('q must contain 2 to 200 characters.');
  }
  // Supabase ilike parameters are bound, but treating wildcard characters as
  // literals prevents an accidental full-table wildcard query.
  const normalized = trimmed.replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length < 2) throw new Error('q must contain at least 2 non-wildcard characters.');
  return normalized;
};

const messageColumns = [
  'message_id',
  'channel_id',
  'created_at',
  'edited_at',
  'content',
  'author_display',
  'mask_state',
  'reply_to_message_id',
  'has_attachments',
  'tombstoned',
].join(',');

const enrichChannelNames = async (rows: Array<Record<string, unknown>>) => {
  const ids = [...new Set(rows.map((row) => String(row.channel_id ?? '')).filter(Boolean))];
  if (ids.length === 0) return rows;
  const { data, error } = await archiveDb().from('channels').select('channel_id,name,type').in('channel_id', ids);
  if (error) throw new Error(`channel lookup failed: ${error.message}`);
  const channels = new Map((data ?? []).map((row) => [String(row.channel_id), row]));
  return rows.map((row) => ({ ...row, channel: channels.get(String(row.channel_id)) ?? null }));
};

export const searchArchive = async (query: string, filters: ArchiveFilters = {}) => {
  const q = normalizeSearchTerm(query);
  const limit = normalizeLimit(filters.limit);
  const from = normalizeDate(filters.from, 'from');
  const to = normalizeDate(filters.to, 'to');
  let request = archiveDb().from('v_messages')
    .select(messageColumns)
    .eq('guild_id', requiredGuildId())
    .ilike('content', `%${q}%`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filters.channelId) request = request.eq('channel_id', filters.channelId);
  if (from) request = request.gte('created_at', from);
  if (to) request = request.lte('created_at', to);
  const { data, error } = await request;
  if (error) throw new Error(`archive search failed: ${error.message}`);
  const results = await enrichChannelNames((data ?? []) as unknown as Array<Record<string, unknown>>);
  return { query: q, count: results.length, results };
};

export const recentArchive = async (filters: ArchiveFilters = {}) => {
  const limit = normalizeLimit(filters.limit);
  const before = normalizeDate(filters.before, 'before');
  let request = archiveDb().from('v_messages')
    .select(messageColumns)
    .eq('guild_id', requiredGuildId())
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filters.channelId) request = request.eq('channel_id', filters.channelId);
  if (before) request = request.lt('created_at', before);
  const { data, error } = await request;
  if (error) throw new Error(`recent archive lookup failed: ${error.message}`);
  const results = await enrichChannelNames((data ?? []) as unknown as Array<Record<string, unknown>>);
  return { count: results.length, results };
};

export const archiveContext = async (messageId: string, radius = 10) => {
  const safeRadius = Math.max(1, Math.min(25, Math.floor(radius)));
  const { data: target, error: targetError } = await archiveDb().from('v_messages')
    .select(messageColumns)
    .eq('guild_id', requiredGuildId())
    .eq('message_id', messageId)
    .maybeSingle();
  if (targetError) throw new Error(`archive context target failed: ${targetError.message}`);
  if (!target) return { target: null, messages: [] };
  const targetRow = target as unknown as Record<string, unknown>;
  const targetChannelId = String(targetRow.channel_id);
  const targetCreatedAt = String(targetRow.created_at);

  const [beforeResult, afterResult] = await Promise.all([
    archiveDb().from('v_messages').select(messageColumns)
      .eq('guild_id', requiredGuildId()).eq('channel_id', targetChannelId)
      .lte('created_at', targetCreatedAt).order('created_at', { ascending: false }).limit(safeRadius + 1),
    archiveDb().from('v_messages').select(messageColumns)
      .eq('guild_id', requiredGuildId()).eq('channel_id', targetChannelId)
      .gt('created_at', targetCreatedAt).order('created_at', { ascending: true }).limit(safeRadius),
  ]);
  if (beforeResult.error) throw new Error(`archive context before failed: ${beforeResult.error.message}`);
  if (afterResult.error) throw new Error(`archive context after failed: ${afterResult.error.message}`);
  const merged = [...(beforeResult.data ?? []).reverse(), ...(afterResult.data ?? [])] as unknown as Array<Record<string, unknown>>;
  return { target: messageId, messages: await enrichChannelNames(merged) };
};

export const listArchiveChannels = async () => {
  const { data, error } = await archiveDb().from('channels')
    .select('channel_id,name,type,parent_id,is_archived,backfill_done')
    .eq('guild_id', requiredGuildId())
    .order('name', { ascending: true });
  if (error) throw new Error(`archive channel list failed: ${error.message}`);
  return { count: data?.length ?? 0, channels: data ?? [] };
};

export const getArchiveStats = async () => {
  const guildId = requiredGuildId();
  const [guild, channels, messages, authors, attachments] = await Promise.all([
    archiveDb().from('guilds').select('backfill_started_at,backfill_completed_at').eq('guild_id', guildId).single(),
    archiveDb().from('channels').select('*', { count: 'exact', head: true }).eq('guild_id', guildId),
    archiveDb().from('messages').select('*', { count: 'exact', head: true }).eq('guild_id', guildId),
    archiveDb().from('authors').select('*', { count: 'exact', head: true }).eq('guild_id', guildId),
    archiveDb().from('attachments').select('messages!inner(guild_id)', { count: 'exact', head: true }).eq('messages.guild_id', guildId),
  ]);
  const firstError = [guild.error, channels.error, messages.error, authors.error, attachments.error].find(Boolean);
  if (firstError) throw new Error(`archive stats failed: ${firstError.message}`);
  if (!guild.data) throw new Error('archive stats failed: guild row not found');
  return {
    channels: channels.count ?? 0,
    messages: messages.count ?? 0,
    authors: authors.count ?? 0,
    attachments: attachments.count ?? 0,
    backfillStartedAt: guild.data.backfill_started_at,
    backfillCompletedAt: guild.data.backfill_completed_at,
  };
};

const asToolResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const createArchiveMcpServer = () => {
  const server = new McpServer({ name: 'muel-personal-archive', version: '1.0.0' });
  server.registerTool('search_archive', {
    title: 'Search personal Discord archive',
    description: 'Search masked messages from the single owner-approved Discord guild. Read-only.',
    inputSchema: {
      query: z.string().min(2).max(200),
      channelId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    },
  }, async ({ query, ...filters }) => asToolResult(await searchArchive(query, filters)));
  server.registerTool('get_archive_context', {
    title: 'Get message context',
    description: 'Return nearby messages from the same channel around one archived message. Read-only.',
    inputSchema: {
      messageId: z.string().min(1),
      radius: z.number().int().min(1).max(25).optional(),
    },
  }, async ({ messageId, radius }) => asToolResult(await archiveContext(messageId, radius)));
  server.registerTool('list_archive_channels', {
    title: 'List archived channels',
    description: 'List channels visible to the archivist and their backfill status. Read-only.',
  }, async () => asToolResult(await listArchiveChannels()));
  server.registerTool('get_archive_stats', {
    title: 'Get archive statistics',
    description: 'Return archive counts and backfill timestamps. Read-only.',
  }, async () => asToolResult(await getArchiveStats()));
  return server;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const handleMcp = async (request: IncomingMessage, response: ServerResponse) => {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    response.end('Method Not Allowed');
    return;
  }
  const body = await readJsonBody(request);
  const server = createArchiveMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
};

export const handleArchivePersonalRequest = async (request: IncomingMessage, response: ServerResponse) => {
  if (!isAuthorized(request)) {
    response.setHeader('www-authenticate', 'Bearer realm="muel-personal-archive"');
    json(response, 401, { error: 'unauthorized' });
    return;
  }
  if (!withinRateLimit()) {
    json(response, 429, { error: 'rate_limited' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/archive/mcp') {
      await handleMcp(request, response);
      return;
    }
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (url.pathname === '/archive/search') {
      json(response, 200, await searchArchive(url.searchParams.get('q') ?? '', {
        channelId: url.searchParams.get('channel_id') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: normalizeLimit(url.searchParams.get('limit')),
      }));
      return;
    }
    if (url.pathname === '/archive/recent') {
      json(response, 200, await recentArchive({
        channelId: url.searchParams.get('channel_id') ?? undefined,
        before: url.searchParams.get('before') ?? undefined,
        limit: normalizeLimit(url.searchParams.get('limit')),
      }));
      return;
    }
    if (url.pathname.startsWith('/archive/context/')) {
      const messageId = decodeURIComponent(url.pathname.slice('/archive/context/'.length));
      json(response, 200, await archiveContext(messageId, normalizeLimit(url.searchParams.get('radius') ?? 10)));
      return;
    }
    if (url.pathname === '/archive/channels') {
      json(response, 200, await listArchiveChannels());
      return;
    }
    if (url.pathname === '/archive/stats') {
      json(response, 200, await getArchiveStats());
      return;
    }
    json(response, 404, { error: 'not_found' });
  } catch (error) {
    console.warn('[archivist] personal archive request failed', { path: url.pathname, error: errorMessage(error) });
    json(response, 400, { error: 'archive_request_failed', message: errorMessage(error) });
  }
};

export const getArchiveOpenApiDocument = (request: IncomingMessage) => {
  const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? 'muel-bot.onrender.com';
  const proto = request.headers['x-forwarded-proto'] ?? 'https';
  return {
    openapi: '3.1.0',
    info: { title: 'Muel Personal Archive', version: '1.0.0', description: 'Read-only access to the owner-approved, privacy-masked Discord archive.' },
    servers: [{ url: `${proto}://${host}` }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths: {
      '/archive/search': { get: { operationId: 'searchArchive', parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2, maxLength: 200 } },
        { name: 'channel_id', in: 'query', schema: { type: 'string' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT } },
      ], responses: { 200: { description: 'Matching masked messages' } } } },
      '/archive/recent': { get: { operationId: 'getRecentArchiveMessages', parameters: [
        { name: 'channel_id', in: 'query', schema: { type: 'string' } },
        { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT } },
      ], responses: { 200: { description: 'Recent masked messages' } } } },
      '/archive/context/{message_id}': { get: { operationId: 'getArchiveMessageContext', parameters: [
        { name: 'message_id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'radius', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 25, default: 10 } },
      ], responses: { 200: { description: 'Nearby messages from the same channel' } } } },
      '/archive/channels': { get: { operationId: 'listArchiveChannels', responses: { 200: { description: 'Archived channels and backfill state' } } } },
      '/archive/stats': { get: { operationId: 'getArchiveStats', responses: { 200: { description: 'Archive counts and backfill timestamps' } } } },
    },
  };
};

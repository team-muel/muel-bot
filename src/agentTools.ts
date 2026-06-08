import { tool } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchServerContext } from './muelContext.js';
import { getRecentMessages as getChannelBufferMessages } from './channelBuffer.js';
import {
  listSemanticMemories,
  formatSemanticMemories,
  disableUserMemorySearch,
} from './muelEmbeddings.js';
import { isHubChannelActive, listHubChannels } from './hubChannels.js';
import { listYouTubeSubscriptions } from './youtubeSubscriptionStore.js';
import { formatYouTubeTarget, getSubscriptionKind, toKindLabel } from './subscribePresentation.js';

/**
 * Stage 4.1 — Read-only Discord tools.
 *
 * All tools here are read-only. Write actions (post_message, add_reaction,
 * edit_message) stay deferred to Stage 5+. Each tool returns a compact string
 * the LLM can quote — never a structured object that requires further parsing
 * inside the assistant.
 *
 * Tool surface intentionally narrow:
 *   - get_server_context: cross-product snapshot (existing, retained).
 *   - search_semantic_memory: per-user long-term memory (existing, retained).
 *   - get_recent_messages: latest N messages from this channel's in-memory buffer.
 *   - get_thread: read messages stored by muel-bot for a given thread context.
 *   - get_hub_status: read current/all hub-channel state.
 *   - get_subscription_status: read YouTube subscription counts and names.
 *   - get_user_profile: Muel profile + last interaction summary for a Discord user.
 *   - search_community_docs: text-match against muel_community_digests.
 *
 * No tool here accesses the Discord client directly. Anything that needs live
 * Discord API calls (e.g. reading arbitrary thread history beyond what Muel
 * has seen) is out of scope until Stage 5 lands write authority too — that's
 * where extra Discord scopes should be justified.
 */

export type AgentToolContext = {
  supabase: SupabaseClient;
  currentChannelId: string | null;
  currentGuildId: string | null;
  relevantUserIds: string[];
  /**
   * ADR-003 P5a — 사용자 본인의 discord user id.
   * 모델이 `search_my_memos` 로 *본인의 직접+자동 메모* 만 안전하게 조회하도록 필터.
   * null 이면 tool 이 *그 사용자 컨텍스트 없음* 메시지 반환.
   */
  currentUserId: string | null;
};

const truncateText = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
};

const summarizeMessages = (messages: Array<{ authorName: string; content: string }>, limit = 12): string => {
  return messages
    .slice(-limit)
    .map((m) => `${m.authorName}: ${truncateText(m.content, 240)}`)
    .join('\n');
};

const summarizeSubscriptionRows = (rows: Awaited<ReturnType<typeof listYouTubeSubscriptions>>, max = 12): string => {
  if (rows.length === 0) return '등록된 YouTube 구독이 없어.';

  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    const kind = getSubscriptionKind(row);
    acc[kind] = (acc[kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([kind, count]) => `${toKindLabel(kind)} ${count}개`)
    .join(', ');
  const lines = rows.slice(0, max).map((row) => `- [${toKindLabel(getSubscriptionKind(row))}] ${formatYouTubeTarget(row)}`);
  const suffix = rows.length > max ? `- ...${rows.length - max}개 더 있음` : '';
  return [`총 ${rows.length}개 (${summary})`, ...lines, suffix].filter(Boolean).join('\n');
};

export const buildAgentTools = (ctx: AgentToolContext) => {
  return {
    get_server_context: tool({
      description:
        'Fetch a cross-product snapshot: YouTube subscriptions, recent dreams (Weave), and the latest community post cache. Use this only when the user asks about recent news, posts, or dream context broadly.',
      inputSchema: z.object({}),
      // @ts-ignore AI SDK v6 tool typing is stricter than the current local wrapper.
      execute: async () => {
        try {
          const context = await fetchServerContext();
          return [
            `[YouTube 구독] ${context.youtubeSourcesSummary}`,
            context.recentYouTubeItems || '',
            `[꿈 네트워크] ${context.recentDreams}`,
            context.recentPosts || '',
          ].filter(Boolean).join('\n\n');
        } catch {
          return '데이터를 가져오는 데 실패했어.';
        }
      },
    }),

    search_semantic_memory: tool({
      description:
        'Search past important conversations with the relevant Discord users. Use only when the user refers to a past discussion or explicitly asks if you remember something.',
      inputSchema: z.object({
        query: z.string().describe('The search query or topic to look up in past conversations.'),
      }),
      // @ts-ignore AI SDK v6 tool typing is stricter than the current local wrapper.
      execute: async ({ query }: { query: string }) => {
        try {
          const results = await listSemanticMemories(ctx.supabase, {
            query,
            guildId: ctx.currentGuildId,
            userIds: ctx.relevantUserIds,
            limit: 8,
          });
          return formatSemanticMemories(results) || '관련된 기억이 없습니다.';
        } catch (error) {
          disableUserMemorySearch(error as { code?: string });
          return '기억을 검색하는 데 실패했어.';
        }
      },
    }),

    /**
     * ADR-003 P5a — *나의 메모* 명시적 조회 tool (read-only).
     *
     * 두 출처 union:
     * - `muel_user_memos` (사용자 직접 /메모 add) — discord_user_id 직접 매핑.
     * - `muel_memory_entries` JOIN `muel_chats.source_user_id` (LLM 자동 추출, status='active').
     *
     * 임베딩 검색은 P5b 후속. 이번 단계는 *최근순 read*. 사용자가 *내가 너한테 뭐
     * 박아뒀더라?* / *내 메모 보여줘* 같은 요청 시 모델이 호출.
     */
    search_my_memos: tool({
      description:
        '사용자(요청자) 본인이 Muel 에게 박아둔 메모 목록을 최신순으로 가져온다. /메모 add 로 직접 박은 것과 LLM 이 자동 추출한 활성 메모리 둘 다 포함. 사용자가 자기 메모/지침/스타일을 묻거나 *너 나에 대해 뭐 알아?* 류 질문 시 사용. limit 기본 8.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).optional().describe('가져올 최대 메모 수 (기본 8)'),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ limit }: { limit?: number }) => {
        if (!ctx.currentUserId) {
          return '지금 누구의 메모를 봐야 할지 모르겠어. (사용자 컨텍스트 없음)';
        }
        const cap = Math.min(Math.max(1, limit ?? 8), 20);
        try {
          const [{ data: direct, error: e1 }, { data: auto, error: e2 }] = await Promise.all([
            ctx.supabase
              .from('muel_user_memos')
              .select('id, content, created_at, metadata')
              .eq('discord_user_id', ctx.currentUserId)
              .order('created_at', { ascending: false })
              .limit(cap),
            ctx.supabase
              .from('muel_memory_entries')
              .select('id, content, kind, importance, created_at, muel_chats!inner(source_user_id)')
              .eq('muel_chats.source_user_id', ctx.currentUserId)
              .eq('status', 'active')
              .order('created_at', { ascending: false })
              .limit(cap),
          ]);
          if (e1) console.warn('[search_my_memos] direct fetch failed', e1);
          if (e2) console.warn('[search_my_memos] auto fetch failed', e2);

          type Row = { source: '직접' | '자동'; content: string; tags: string[]; kind: string | null; created_at: string };
          const rows: Row[] = [];
          for (const r of direct ?? []) {
            const md = (r as { metadata?: Record<string, unknown> }).metadata ?? {};
            const tagsRaw = (md as Record<string, unknown>).tags;
            const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === 'string') : [];
            const kind = typeof (md as Record<string, unknown>).kind === 'string' ? String((md as Record<string, unknown>).kind) : null;
            rows.push({ source: '직접', content: String(r.content), tags, kind, created_at: String(r.created_at) });
          }
          for (const r of auto ?? []) {
            rows.push({
              source: '자동',
              content: String(r.content),
              tags: [],
              kind: typeof r.kind === 'string' ? r.kind : null,
              created_at: String(r.created_at),
            });
          }
          rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          const slice = rows.slice(0, cap);
          if (slice.length === 0) return '저장된 메모가 없어.';

          return slice
            .map((r, i) => {
              const date = new Date(r.created_at).toISOString().slice(0, 10);
              const meta = [r.source, r.kind ?? null, date].filter(Boolean).join(' · ');
              const tagLine = r.tags.length > 0 ? ` [${r.tags.map((t) => `#${t}`).join(' ')}]` : '';
              return `${i + 1}. (${meta})${tagLine} ${truncateText(r.content, 280)}`;
            })
            .join('\n');
        } catch (err) {
          console.warn('[search_my_memos] failed', err);
          return '메모 조회에 실패했어.';
        }
      },
    }),

    get_recent_messages: tool({
      description:
        'Read the latest messages in THIS channel that Muel has buffered. Use only when the user asks about what was just said in this channel. Returns at most 12 message lines.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(15).default(10).describe('How many recent messages to retrieve. Default 10, max 15.'),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ limit }: { limit: number }) => {
        if (!ctx.currentChannelId) {
          return '현재 채널 컨텍스트가 없어. 이 도구는 채널 안에서만 쓸 수 있어.';
        }
        const buffered = getChannelBufferMessages(ctx.currentChannelId, limit);
        if (buffered.length === 0) {
          return '이 채널 버퍼에 최근 메시지가 없어.';
        }
        return summarizeMessages(buffered, Math.min(limit, 12));
      },
    }),

    get_thread: tool({
      description:
        'Read the messages Muel has stored for a particular Discord thread (only threads where someone interacted with Muel). Useful when the user asks "what did we discuss in that thread".',
      inputSchema: z.object({
        threadId: z.string().describe('Discord thread/channel ID. Must be a 17–20 digit Discord snowflake.'),
        limit: z.number().int().min(1).max(20).default(12).describe('How many messages to retrieve. Default 12, max 20.'),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ threadId, limit }: { threadId: string; limit: number }) => {
        if (!/^\d{17,20}$/.test(threadId)) {
          return '쓰레드 ID 형식이 이상해. Discord snowflake (17~20자리 숫자)가 필요해.';
        }
        const { data, error } = await ctx.supabase
          .from('muel_chats')
          .select('id, source_thread_id')
          .eq('source_thread_id', threadId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return '쓰레드 조회에 실패했어.';
        if (!data?.id) return '내가 본 적 없는 쓰레드야.';

        const { data: messages, error: msgError } = await ctx.supabase
          .from('muel_messages_v2')
          .select('role, parts, metadata, created_at')
          .eq('chat_id', data.id)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (msgError) return '쓰레드 메시지 조회에 실패했어.';
        if (!messages || messages.length === 0) return '이 쓰레드에 저장된 메시지가 없어.';

        const lines = messages.reverse().map((m: any) => {
          const text = Array.isArray(m.parts)
            ? m.parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ')
            : '';
          const speaker = m.role === 'assistant' ? 'Muel' : (m.metadata?.discordUsername ?? m.role);
          return `${speaker}: ${truncateText(text, 240)}`;
        });
        return lines.join('\n');
      },
    }),

    get_hub_status: tool({
      description:
        'Read Muel Hub status for this server/channel. Use when the user asks whether Muel is active in this channel, which channels have hub enabled, or asks for hub status. Read-only; does not enable or disable anything.',
      inputSchema: z.object({
        scope: z.enum(['current_channel', 'all_channels']).default('current_channel'),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ scope }: { scope: 'current_channel' | 'all_channels' }) => {
        if (!ctx.currentGuildId) return '서버 컨텍스트가 없어. 허브 상태는 서버 안에서만 볼 수 있어.';
        if (scope === 'current_channel') {
          if (!ctx.currentChannelId) return '현재 채널 컨텍스트가 없어.';
          const active = await isHubChannelActive(ctx.supabase, {
            guildId: ctx.currentGuildId,
            channelId: ctx.currentChannelId,
          }).catch(() => false);
          return active
            ? '현재 채널은 Muel Hub가 켜져 있어. 일반 메시지에도 조건이 맞으면 응답할 수 있어.'
            : '현재 채널은 Muel Hub가 꺼져 있어. 켜려면 채널 관리 권한자가 확인 버튼 또는 /허브 활성화를 사용해야 해.';
        }

        const channels = await listHubChannels(ctx.supabase, { guildId: ctx.currentGuildId }).catch(() => null);
        if (!channels) return '허브 목록 조회에 실패했어.';
        if (channels.length === 0) return '이 서버에 활성화된 허브 채널이 없어.';
        return [
          `활성 허브 채널 ${channels.length}개`,
          ...channels.slice(0, 12).map((row) => `- <#${row.channelId}> · 응답 임계값 ${row.responsiveConfidenceMin.toFixed(2)}`),
          channels.length > 12 ? `- ...${channels.length - 12}개 더 있음` : '',
        ].filter(Boolean).join('\n');
      },
    }),

    get_subscription_status: tool({
      description:
        'Read YouTube subscription status for this server or current channel. Use when the user asks what is subscribed, whether this channel has subscriptions, or asks for /구독 state. Read-only; does not add/remove subscriptions.',
      inputSchema: z.object({
        scope: z.enum(['current_channel', 'server']).default('server'),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ scope }: { scope: 'current_channel' | 'server' }) => {
        if (!ctx.currentGuildId) return '서버 컨텍스트가 없어. 구독 상태는 서버 안에서만 볼 수 있어.';
        const rows = await listYouTubeSubscriptions({ guildId: ctx.currentGuildId }).catch(() => null);
        if (!rows) return 'YouTube 구독 상태 조회에 실패했어.';
        const filtered = scope === 'current_channel' && ctx.currentChannelId
          ? rows.filter((row) => row.channel_id === ctx.currentChannelId)
          : rows;
        return summarizeSubscriptionRows(filtered);
      },
    }),

    get_user_profile: tool({
      description:
        'Look up a Muel profile and recent interaction summary for a specific Discord user. Use only when the user asks about themselves or another user by Discord ID.',
      inputSchema: z.object({
        userId: z.string().describe('Discord user ID (17–20 digit snowflake).'),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ userId }: { userId: string }) => {
        if (!/^\d{17,20}$/.test(userId)) {
          return '사용자 ID 형식이 이상해.';
        }
        const { data: identity, error: identityError } = await ctx.supabase
          .from('muel_profile_identities')
          .select('profile_id, username, metadata')
          .eq('provider', 'discord')
          .eq('provider_user_id', userId)
          .maybeSingle();
        if (identityError) return '프로필 조회에 실패했어.';
        if (!identity?.profile_id) return '이 사용자의 Muel 프로필이 아직 만들어지지 않았어.';

        const { data: profile } = await ctx.supabase
          .from('muel_profiles')
          .select('display_name, created_at, updated_at')
          .eq('id', identity.profile_id)
          .maybeSingle();

        const { count: messageCount } = await ctx.supabase
          .from('muel_messages_v2')
          .select('id', { count: 'exact', head: true })
          .eq('metadata->>discordUserId', userId);

        const lines = [
          `Muel 프로필: ${profile?.display_name ?? identity.username ?? userId}`,
          `Discord 사용자명: ${identity.username ?? '알 수 없음'}`,
          profile?.created_at ? `최초 기록: ${profile.created_at.slice(0, 10)}` : '',
          typeof messageCount === 'number' ? `Muel과 주고받은 메시지: ${messageCount}개` : '',
        ].filter(Boolean);

        return lines.join('\n');
      },
    }),

    search_community_docs: tool({
      description:
        'Search summarized community digests (muel_community_digests) by keyword. Use when the user asks about a past channel surge, recap, or summary topic.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Keyword or phrase to match against digest titles and summaries.'),
        limit: z.number().int().min(1).max(8).default(5),
      }),
      // @ts-ignore AI SDK v6 tool typing.
      execute: async ({ query, limit }: { query: string; limit: number }) => {
        const ilike = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const { data, error } = await ctx.supabase
          .from('muel_community_digests')
          .select('title, summary, highlights, created_at, channel_id')
          .or(`title.ilike.${ilike},summary.ilike.${ilike}`)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error) return '커뮤니티 다이제스트 검색에 실패했어.';
        if (!data || data.length === 0) return '관련된 다이제스트가 없어.';

        return data.map((row: any) => {
          const headline = `${row.created_at.slice(0, 10)} · ${row.title}`;
          const summary = truncateText(row.summary ?? '', 220);
          const highlights = Array.isArray(row.highlights) && row.highlights.length > 0
            ? `  highlights: ${row.highlights.slice(0, 3).map((h: string) => truncateText(h, 100)).join(' / ')}`
            : '';
          return [headline, `  ${summary}`, highlights].filter(Boolean).join('\n');
        }).join('\n\n');
      },
    }),
  };
};

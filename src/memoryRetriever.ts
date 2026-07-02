import type { SupabaseClient } from '@supabase/supabase-js';
import { embedMuelText } from './muelEmbeddings.js';

// Injection thresholds — the high bar actually used to put memories in the prompt.
const MEMORY_RETRIEVAL_LIMIT = 3;
const MEMORY_MIN_SIMILARITY = 0.72;

// Observation-only band: we query a wider/looser set than we inject so retrieval
// recall is measurable from real traffic (memory_retrieval_logs) BEFORE tuning the
// injection threshold. Changing these does NOT change what the model sees.
const MEMORY_OBSERVE_THRESHOLD = 0.3;
const MEMORY_OBSERVE_COUNT = 8;

// 사용자가 /메모 또는 Weave '알려주기' 로 직접 남긴 지침. 의미 유사도와 무관하게
// 항상 우선 주입한다(직접 지시라 늘 유효). 너무 많으면 프롬프트 비대 → 최근 N 개로 제한.
const DIRECT_MEMO_LIMIT = 8;
const DIRECT_MEMO_MAX_CHARS = 300;

type ObservedMemory = { content: string; similarity: number };

const logRetrieval = async (
  supabase: SupabaseClient,
  row: {
    query: string;
    observedCount: number;
    usedCount: number;
    avgObservedScore: number | null;
    topScore: number | null;
    latencyMs: number;
  },
): Promise<void> => {
  console.log('[memory-retrieval]', {
    observed: row.observedCount,
    used: row.usedCount,
    top: row.topScore,
    avg: row.avgObservedScore,
    useThreshold: MEMORY_MIN_SIMILARITY,
    latencyMs: row.latencyMs,
  });
  try {
    await supabase.from('memory_retrieval_logs').insert({
      id: crypto.randomUUID(),
      query_type: 'user_memory',
      query: row.query.slice(0, 500),
      requested_top_k: MEMORY_OBSERVE_COUNT,
      returned_count: row.observedCount,
      query_latency_ms: row.latencyMs,
      avg_score: row.avgObservedScore,
    });
  } catch (err) {
    console.warn('[memory-retrieval] log insert failed', err);
  }
};

// 사용자가 직접 남긴 지침(muel_user_memos)을 가져온다. 임베딩/유사도 없이 최근 것 우선.
const fetchDirectMemos = async (supabase: SupabaseClient, userId: string): Promise<string[]> => {
  try {
    const { data, error } = await supabase
      .from('muel_user_memos')
      .select('content')
      .eq('discord_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(DIRECT_MEMO_LIMIT);
    if (error) {
      console.warn('[memory-retrieval] user_memos fetch failed', error);
      return [];
    }
    return (data ?? [])
      .map((m: { content: string | null }) => (m.content ?? '').trim())
      .filter((c): c is string => c.length > 0)
      .map((c) => (c.length > DIRECT_MEMO_MAX_CHARS ? `${c.slice(0, DIRECT_MEMO_MAX_CHARS - 1)}…` : c));
  } catch (err) {
    console.warn('[memory-retrieval] user_memos fetch threw', err);
    return [];
  }
};

/**
 * 직접 지침만 포맷해 반환 — 임베딩 호출 없음(저비용). lightweight 잡담 턴 전용.
 *
 * Why: semantic memory 주입은 비-lightweight 턴 전용인데 실트래픽이 거의 전부
 * lightweight 라 30일간 retrieval 0건 — 읽기 경로가 통째로 죽어 있었다.
 * /메모·Weave 로 남긴 직접 지침만이라도 잡담 턴에 저비용으로 살린다.
 */
export async function retrieveDirectMemoText(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const directLines = await fetchDirectMemos(supabase, userId);
  if (directLines.length === 0) return '';
  return [
    '사용자가 너에게 직접 남긴 지침 (별도 언급 없이 항상 반영):',
    ...directLines.map((c) => `- ${c}`),
    '',
    "If the user's current message contradicts any stored memory, follow the current message.",
    'Do not mention that you are using memory.',
  ].join('\n');
}

/**
 * Retrieve long-term + user-directed memory for a user, formatted for the system prompt.
 * - 사용자 직접 지침(muel_user_memos): 항상 우선 주입 (/메모·Weave 알려주기 → 실제 반영).
 * - 의미 기반 장기 기억(muel_memory_entries): 임베딩 유사도 임계 이상만 주입.
 * Returns '' if nothing to inject. Fails silently — never blocks chat.
 */
export async function retrieveRelevantMemories(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    query: string;
  }
): Promise<string> {
  const { userId, query } = opts;
  const sections: string[] = [];

  // 1) 사용자 직접 지침 — 늘 우선.
  const directLines = await fetchDirectMemos(supabase, userId);
  if (directLines.length > 0) {
    sections.push(
      '사용자가 너에게 직접 남긴 지침 (별도 언급 없이 항상 반영):',
      ...directLines.map((c) => `- ${c}`),
    );
  }

  // 2) 의미 기반 장기 기억.
  const startedAt = Date.now();
  const embedding = await embedMuelText(query);
  if (embedding) {
    const { data: observed, error } = await supabase.rpc('match_user_memories', {
      p_user_id: userId,
      p_query_embedding: embedding,
      p_match_threshold: MEMORY_OBSERVE_THRESHOLD,
      p_match_count: MEMORY_OBSERVE_COUNT,
    });

    if (error) {
      console.warn('[memory-retrieval] match_user_memories RPC failed', error);
    } else {
      const observedRows = (observed ?? []) as ObservedMemory[];
      const matches = observedRows
        .filter((m) => Number(m.similarity) >= MEMORY_MIN_SIMILARITY)
        .slice(0, MEMORY_RETRIEVAL_LIMIT);

      void logRetrieval(supabase, {
        query,
        observedCount: observedRows.length,
        usedCount: matches.length,
        avgObservedScore: observedRows.length
          ? observedRows.reduce((sum, m) => sum + Number(m.similarity), 0) / observedRows.length
          : null,
        topScore: observedRows.length ? Math.max(...observedRows.map((m) => Number(m.similarity))) : null,
        latencyMs: Date.now() - startedAt,
      });

      if (matches.length > 0) {
        if (sections.length > 0) sections.push('');
        sections.push(
          'Relevant long-term user context:',
          ...matches.map((m) => `- ${m.content}`),
        );
      }
    }
  }

  if (sections.length === 0) return '';

  sections.push(
    '',
    "If the user's current message contradicts any stored memory, follow the current message.",
    'Do not mention that you are using memory.',
  );
  return sections.join('\n');
}

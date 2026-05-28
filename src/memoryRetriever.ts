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

type ObservedMemory = { content: string; similarity: number };

/**
 * Fire-and-forget instrumentation row. Never throws.
 * returned_count = candidates observed at the loose threshold; avg_score = mean
 * observed similarity. Compare against MEMORY_MIN_SIMILARITY to see how much
 * relevant context the 0.72 injection bar is currently discarding.
 */
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

/**
 * Retrieve relevant long-term memories for a user based on the current message.
 * Returns a formatted string ready to inject into the system prompt,
 * or an empty string if no relevant memories are found.
 *
 * Designed to fail silently — a retrieval error must never block the chat flow.
 */
export async function retrieveRelevantMemories(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    query: string;
  }
): Promise<string> {
  const { userId, query } = opts;

  const startedAt = Date.now();
  const embedding = await embedMuelText(query);
  if (!embedding) return '';

  // Observe a wider band than we inject (see constants above).
  const { data: observed, error } = await supabase.rpc('match_user_memories', {
    p_user_id: userId,
    p_query_embedding: embedding,
    p_match_threshold: MEMORY_OBSERVE_THRESHOLD,
    p_match_count: MEMORY_OBSERVE_COUNT,
  });

  if (error) {
    console.warn('[memory-retrieval] match_user_memories RPC failed', error);
    return '';
  }

  const observedRows = (observed ?? []) as ObservedMemory[];

  // Inject only high-confidence matches (chat behavior unchanged vs. before).
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
    topScore: observedRows.length
      ? Math.max(...observedRows.map((m) => Number(m.similarity)))
      : null,
    latencyMs: Date.now() - startedAt,
  });

  if (matches.length === 0) return '';

  const lines = matches.map((m) => `- ${m.content}`);

  return [
    'Relevant long-term user context:',
    ...lines,
    '',
    'Use these memories only when they directly help answer the current request.',
    "If the user's current message contradicts any stored memory, follow the current message.",
    'Do not mention that you are using memory.',
  ].join('\n');
}

import { embed } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Hardcoded initial values — tune after observing real logs
const MEMORY_RETRIEVAL_LIMIT = 3;
const MEMORY_MIN_SIMILARITY = 0.72;

let embeddingModel: ReturnType<ReturnType<typeof createGoogleGenerativeAI>['textEmbeddingModel']> | null = null;

function getEmbeddingModel() {
  if (!embeddingModel && config.googleGenerativeAiApiKey) {
    const google = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey });
    embeddingModel = google.textEmbeddingModel('text-embedding-004');
  }
  return embeddingModel;
}

/**
 * Retrieve relevant long-term memories for a user based on the current message.
 * Returns a formatted string ready to inject into the system prompt,
 * or an empty string if no relevant memories are found.
 *
 * This function is designed to fail silently — a retrieval error
 * should never block the main conversation flow.
 */
export async function retrieveRelevantMemories(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    query: string;
  }
): Promise<string> {
  const { userId, query } = opts;

  const model = getEmbeddingModel();
  if (!model) return '';

  // 1. Embed the current user message
  const { embedding } = await embed({ model, value: query });

  // 2. Call the DB-side similarity search RPC
  const { data: matches, error } = await supabase.rpc('match_user_memories', {
    p_user_id: userId,
    p_query_embedding: embedding,
    p_match_threshold: MEMORY_MIN_SIMILARITY,
    p_match_count: MEMORY_RETRIEVAL_LIMIT,
  });

  if (error) {
    console.warn('[memory-retrieval] match_user_memories RPC failed', error);
    return '';
  }

  if (!matches || matches.length === 0) return '';

  // 3. Format for system prompt injection
  const lines = matches.map((m: any) => `- ${m.content}`);

  return [
    'Relevant long-term user context:',
    ...lines,
    '',
    'Use these memories only when they directly help answer the current request.',
    "If the user's current message contradicts any stored memory, follow the current message.",
    'Do not mention that you are using memory.',
  ].join('\n');
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

export type SemanticMemory = {
  author: string;
  content: string;
  similarity: number;
};

let canSearchUserMemory = true;

type GeminiEmbeddingResponse = {
  embedding?: {
    values?: number[];
  };
  embeddings?: Array<{
    values?: number[];
  }>;
  error?: {
    message?: string;
  };
};

const toVectorLiteral = (values: number[]): string => {
  return `[${values.map((value) => Number(value).toFixed(8)).join(',')}]`;
};

const EMBED_RETRY_DELAYS_MS = [1_000, 3_000];

export const embedMuelText = async (
  text: string,
): Promise<number[] | null> => {
  const input = text.trim();
  if (!config.googleGenerativeAiApiKey || !input) return null;

  // 429/5xx 에 짧은 백오프 재시도 — extract_memory 잡이 임베딩 429 로 조용히
  // 실패하는 사례가 텔레메트리에 잡혀서(2026-07-02 감사) 단발 호출을 보강.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= EMBED_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, EMBED_RETRY_DELAYS_MS[attempt - 1]));
    }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.muelEmbeddingModel}:embedContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.googleGenerativeAiApiKey,
      },
      body: JSON.stringify({
        content: {
          parts: [{ text: input.slice(0, 8000) }],
        },
        output_dimensionality: config.muelEmbeddingDimensions,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const data = (await response.json()) as GeminiEmbeddingResponse;
    if (!response.ok) {
      lastError = new Error(`Gemini embedding HTTP ${response.status}: ${data.error?.message ?? 'unknown error'}`);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < EMBED_RETRY_DELAYS_MS.length) continue;
      throw lastError;
    }

    const values = data.embedding?.values ?? data.embeddings?.[0]?.values ?? null;
    if (!values || values.length !== config.muelEmbeddingDimensions) {
      throw new Error(`Gemini embedding returned ${values?.length ?? 0} dimensions, expected ${config.muelEmbeddingDimensions}`);
    }
    return values;
  }
  throw lastError ?? new Error('Gemini embedding failed');
};

export const storeMessageEmbedding = async (
  supabase: SupabaseClient,
  messageId: string,
  content: string,
): Promise<void> => {
  void supabase;
  void messageId;
  void content;
};

export const listSemanticMemories = async (
  supabase: SupabaseClient,
  input: {
    query: string;
    guildId?: string | null;
    userIds?: string[];
    limit?: number;
  },
): Promise<SemanticMemory[]> => {
  if (!canSearchUserMemory) return [];

  const embedding = await embedMuelText(`task: question answering | query: ${input.query}`);
  if (!embedding) return [];

  const userIds = [...new Set((input.userIds ?? []).filter(Boolean))];
  if (userIds.length === 0) return [];

  const results = await Promise.all(userIds.slice(0, 5).map(async (userId) => {
    const { data, error } = await supabase.rpc('match_user_memories', {
      p_user_id: userId,
      p_query_embedding: toVectorLiteral(embedding),
      p_match_threshold: 0.45,
      p_match_count: input.limit ?? 8,
    });

    if (error) {
      console.warn('[memory] match_user_memories failed for a user; skipping', error);
      return [];
    }

    return ((data ?? []) as Array<{
      content: string;
      similarity: number;
    }>)
      .filter((item) => item.content && item.similarity >= 0.45)
      .map((item) => ({
        author: userId,
        content: item.content,
        similarity: item.similarity,
      }));
  }));

  return results
    .flat()
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, input.limit ?? 8);
};

export const disableUserMemorySearch = (error: { code?: string } | null | undefined): void => {
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    canSearchUserMemory = false;
  }
};

export const formatSemanticMemories = (memories: SemanticMemory[]): string => {
  if (memories.length === 0) return '';

  const lines = ['--- Relevant Memory ---'];
  for (const memory of memories.slice(0, 8)) {
    lines.push(`${memory.author}: ${memory.content.slice(0, 180)}`);
  }
  lines.push('--- End Memory ---');
  return lines.join('\n');
};

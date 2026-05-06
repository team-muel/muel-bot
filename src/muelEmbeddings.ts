import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

export type SemanticMemory = {
  author: string;
  content: string;
  similarity: number;
};

let canStoreMessageEmbeddings = true;
let canSearchSemanticMemory = true;

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

export const embedMuelText = async (
  text: string,
): Promise<number[] | null> => {
  const input = text.trim();
  if (!config.googleGenerativeAiApiKey || !input) return null;

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
    throw new Error(`Gemini embedding HTTP ${response.status}: ${data.error?.message ?? 'unknown error'}`);
  }

  const values = data.embedding?.values ?? data.embeddings?.[0]?.values ?? null;
  if (!values || values.length !== config.muelEmbeddingDimensions) {
    throw new Error(`Gemini embedding returned ${values?.length ?? 0} dimensions, expected ${config.muelEmbeddingDimensions}`);
  }

  return values;
};

export const storeMessageEmbedding = async (
  supabase: SupabaseClient,
  messageId: string,
  content: string,
): Promise<void> => {
  if (!canStoreMessageEmbeddings) return;

  const embedding = await embedMuelText(`title: Discord message | text: ${content}`);
  if (!embedding) return;

  const { error } = await supabase
    .from('muel_messages')
    .update({ embedding: toVectorLiteral(embedding) })
    .eq('id', messageId);

  if (error) {
    if (error.code === '42703') {
      canStoreMessageEmbeddings = false;
    }
    throw error;
  }
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
  if (!canSearchSemanticMemory) return [];

  const embedding = await embedMuelText(`task: question answering | query: ${input.query}`);
  if (!embedding) return [];

  const { data, error } = await supabase.rpc('match_muel_messages', {
    query_embedding: toVectorLiteral(embedding),
    match_guild_id: input.guildId ?? null,
    match_user_ids: input.userIds ?? [],
    match_count: input.limit ?? 8,
  });

  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      canSearchSemanticMemory = false;
    }
    throw error;
  }

  return ((data ?? []) as Array<{
    discord_username: string | null;
    content: string;
    similarity: number;
  }>)
    .filter((item) => item.content && item.similarity >= 0.45)
    .map((item) => ({
      author: item.discord_username ?? 'unknown',
      content: item.content,
      similarity: item.similarity,
    }));
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

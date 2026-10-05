import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertSupabaseDataApiAvailable,
  observeSupabaseDataApiError,
} from './serviceRestriction.js';

export async function enqueueJob(
  supabase: SupabaseClient,
  type: string,
  payload: Record<string, unknown>,
  dedupeKey?: string,
  runAfter?: string,
): Promise<string | null> {
  assertSupabaseDataApiAvailable();
  const row = {
    type,
    payload,
    dedupe_key: dedupeKey ?? null,
    status: 'pending',
    run_after: runAfter ?? new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('muel_jobs')
    .insert(row)
    .select('id')
    .single();

  if (!error) {
    return data?.id ?? null;
  }

  observeSupabaseDataApiError(error);

  if (error.code === '23505' && dedupeKey) {
    const { data: existing, error: selectError } = await supabase
      .from('muel_jobs')
      .select('id')
      .eq('type', type)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();

    if (selectError) {
      observeSupabaseDataApiError(selectError);
      throw selectError;
    }
    return existing?.id ?? null;
  }

  if (error.code !== '23505') {
    throw error;
  }

  return null;
}

const MEMORY_EXTRACTION_WINDOW_MS = 30 * 60 * 1000;

export async function enqueueMemoryExtractionJob(
  supabase: SupabaseClient,
  payload: {
    chatId: string;
    messageId: string;
    source: string;
    createdAt: string;
    ownerUserId?: string | null;
  },
) {
  try {
    const now = Date.now();
    const windowId = Math.floor(now / MEMORY_EXTRACTION_WINDOW_MS);
    const runAfter = new Date((windowId + 1) * MEMORY_EXTRACTION_WINDOW_MS).toISOString();
    const ownerKey = payload.ownerUserId ?? 'unknown';
    const dedupeKey = `extract_memory:${payload.chatId}:${ownerKey}:${windowId}`;

    await enqueueJob(supabase, 'extract_memory', payload, dedupeKey, runAfter);

    // A later turn in the same window should be the extraction boundary. The
    // unique dedupe key keeps one LLM job, while this lightweight DB update
    // lets that job see the latest conversation available in the window.
    const { error } = await supabase
      .from('muel_jobs')
      .update({ payload, run_after: runAfter })
      .eq('type', 'extract_memory')
      .eq('dedupe_key', dedupeKey)
      .in('status', ['pending', 'failed']);

    if (error) {
      observeSupabaseDataApiError(error);
      console.warn('[jobs] memory coalesce update failed', error);
    }
  } catch (err) {
    console.error('[jobs] enqueue exception', err);
  }
}

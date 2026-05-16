import type { SupabaseClient } from '@supabase/supabase-js';

export async function enqueueJob(
  supabase: SupabaseClient,
  type: string,
  payload: Record<string, unknown>,
  dedupeKey?: string,
  runAfter?: string,
): Promise<string | null> {
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

  if (error.code === '23505' && dedupeKey) {
    const { data: existing, error: selectError } = await supabase
      .from('muel_jobs')
      .select('id')
      .eq('type', type)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();

    if (selectError) {
      throw selectError;
    }
    return existing?.id ?? null;
  }

  if (error.code !== '23505') {
    throw error;
  }

  return null;
}

export async function enqueueMemoryExtractionJob(
  supabase: SupabaseClient,
  payload: { chatId: string; messageId: string; source: string; createdAt: string }
) {
  try {
    const runAfter = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 mins delay
    await enqueueJob(supabase, 'extract_memory', payload, `extract_memory:${payload.messageId}`, runAfter);
  } catch (err) {
    console.error('[jobs] enqueue exception', err);
  }
}

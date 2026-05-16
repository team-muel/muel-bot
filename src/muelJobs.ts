import type { SupabaseClient } from '@supabase/supabase-js';

export async function enqueueMemoryExtractionJob(
  supabase: SupabaseClient,
  payload: { chatId: string; messageId: string; source: string; createdAt: string }
) {
  try {
    const runAfter = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 mins delay
    
    const { error } = await supabase.from('muel_jobs').upsert({
      type: 'extract_memory',
      payload,
      dedupe_key: `extract_memory:${payload.chatId}`,
      status: 'pending',
      run_after: runAfter,
    }, { onConflict: 'type, dedupe_key' });
    
    if (error && error.code !== '23505') { // ignore unique violation just in case
      console.warn('[jobs] memory_job_enqueue_failed', error);
    }
  } catch (err) {
    console.error('[jobs] enqueue exception', err);
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';

export async function enqueueMemoryExtractionJob(
  supabase: SupabaseClient,
  payload: { chatId: string; messageId: string; source: string; createdAt: string }
) {
  try {
    const { error } = await supabase.rpc('enqueue_job', {
      p_type: 'extract_memory',
      p_payload: payload,
      p_dedupe_key: `extract_memory:${payload.messageId}`,
    });
    
    if (error) {
      console.warn('[jobs] memory_job_enqueue_failed', {
        event: 'memory_job_enqueue_failed',
        chatId: payload.chatId,
        messageId: payload.messageId,
        error: error.message || error,
      });
    }
  } catch (err) {
    console.error('[jobs] enqueue exception', err);
  }
}

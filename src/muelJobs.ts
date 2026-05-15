import type { SupabaseClient } from '@supabase/supabase-js';

export async function enqueueMemoryExtractionJob(
  supabase: SupabaseClient,
  payload: { chatId: string; messageId: string; source: string; createdAt: string }
) {
  try {
    const { error } = await supabase.rpc('enqueue_job', {
      p_type: 'extract_memory',
      p_payload: payload,
    });
    
    if (error) {
      console.error('[jobs] enqueue memory extraction failed', error);
    }
  } catch (err) {
    console.error('[jobs] enqueue exception', err);
  }
}

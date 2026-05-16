import { createClient } from '@supabase/supabase-js';
import { generateObject, embed } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config } from './config.js';

if (!config.supabaseUrl || !config.supabaseServiceRoleKey || !config.googleGenerativeAiApiKey) {
  console.warn('[memory] Missing required config for memory worker. It will not run correctly.');
}

const supabase = createClient(config.supabaseUrl || '', config.supabaseServiceRoleKey || '');
const google = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey || '' });
const model = google('gemini-2.5-flash');
const embeddingModel = google.textEmbeddingModel('text-embedding-004');

const extractMemorySchema = z.object({
  memories: z.array(z.object({
    content: z.string().describe("Dense, profound, persistent truth about the user. e.g. 'Prefers Samsung over Apple because of technical transparency'"),
    importance_score: z.number().min(0.5).max(1.0).describe("Scale 0.5-1.0. 0.5 for mild preferences, 1.0 for fundamental worldview or identity."),
  })).describe("List of profound facts. Empty if nothing profound is found in the recent messages.")
});

const SYSTEM_PROMPT = `Analyze the following conversation segment and extract ONLY profound, persistent truths about the user's worldview, core preferences, deep working methods, or long-term identity. 

CRITICAL RULES:
1. DO NOT extract ephemeral facts (e.g. "User ate pizza", "User is debugging a bug today", "User asked about a command").
2. DO NOT extract simple greetings or context-dependent opinions.
3. Extracted memories should be high-signal, standalone facts that permanently change how an AI should understand this user.
4. If there is nothing profound or long-term in this segment, return an empty array [].
5. It is expected that 95% of conversations result in NO memories extracted. Be extremely picky.`;

export async function processMemoryJob(job: any) {
  const { payload } = job;
  const { chatId, messageId } = payload;

  // 1. Fetch chat to find the user id
  const { data: chatData, error: chatError } = await supabase
    .from('muel_chats')
    .select('source_user_id, source')
    .eq('id', chatId)
    .single();

  if (chatError || !chatData) {
    throw new Error(`Failed to fetch chat info: ${chatError?.message}`);
  }

  // 2. Fetch the recent messages in this chat up to the messageId
  // We fetch last 10 messages before or equal to this message
  const { data: messages, error: messagesError } = await supabase
    .from('muel_messages_v2')
    .select('id, role, parts, created_at')
    .eq('chat_id', chatId)
    .lte('created_at', payload.createdAt)
    .order('created_at', { ascending: false })
    .limit(10);

  if (messagesError || !messages) {
    throw new Error(`Failed to fetch messages: ${messagesError?.message}`);
  }

  // Reverse to chronological order
  messages.reverse();

  // Format conversation for the prompt
  const conversationText = messages.map(m => {
    const textParts = m.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ') || '';
    return `[${m.role}] ${textParts}`;
  }).join('\n');

  if (!conversationText.trim()) return; // Nothing to analyze

  // 3. Generate Object
  const { object } = await generateObject({
    model,
    schema: extractMemorySchema,
    prompt: `${SYSTEM_PROMPT}\n\nCONVERSATION:\n${conversationText}`,
  });

  // 4. Insert extracted memories
  for (const memory of object.memories) {
    console.log(`[memory] Extracted dense fact: ${memory.content} (score: ${memory.importance_score})`);
    
    // Insert into muel_memory_entries
    const { data: entryData, error: entryError } = await supabase
      .from('muel_memory_entries')
      .insert({
        user_id: chatData.source_user_id || 'unknown',
        content: memory.content,
        source_type: chatData.source,
        source_id: chatId,
        importance_score: memory.importance_score,
      })
      .select('id')
      .single();

    if (entryError || !entryData) {
      console.error('[memory] Failed to insert entry', entryError);
      continue;
    }

    // 5. Generate Embedding
    try {
      const { embedding } = await embed({
        model: embeddingModel,
        value: memory.content,
      });

      // Insert into muel_memory_embeddings
      const { error: embedError } = await supabase
        .from('muel_memory_embeddings')
        .insert({
          entry_id: entryData.id,
          embedding,
        });

      if (embedError) {
        console.error('[memory] Failed to insert embedding', embedError);
      }
    } catch (embErr) {
      console.error('[memory] Failed to generate/insert embedding', embErr);
    }
  }
}

export async function runMemoryWorkerLoop() {
  console.log('[memory] Worker started');
  while (true) {
    try {
      const { data: jobs, error } = await supabase.rpc('claim_pending_jobs', {
        p_worker_id: 'memory-worker-node',
        p_limit: 5,
      });

      if (error) {
        console.error('[memory] claim_pending_jobs error', error);
      } else if (jobs && jobs.length > 0) {
        for (const job of jobs) {
          try {
            if (job.type === 'extract_memory') {
              await processMemoryJob(job);
            }
            // Complete job
            await supabase.rpc('complete_job', { p_job_id: job.id });
          } catch (jobErr: any) {
            console.error(`[memory] job ${job.id} failed`, jobErr);
            await supabase.rpc('fail_job', {
              p_job_id: job.id,
              p_error: jobErr.message || 'Unknown error',
              p_retry_delay_seconds: 60 * 5, // Retry after 5 mins
            });
          }
        }
      }
    } catch (err) {
      console.error('[memory] worker loop error', err);
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

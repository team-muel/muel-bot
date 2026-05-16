import { generateObject, embed } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config } from './config.js';
import { getSupabaseClient } from './supabase.js';

const google = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey || '' });
const model = google('gemini-2.5-flash');
const embeddingModel = google.textEmbeddingModel('text-embedding-004');

const extractMemorySchema = z.object({
  memories: z.array(z.object({
    content: z.string().describe("Dense, profound, persistent truth about the user."),
    kind: z.enum([
      'fact',
      'preference',
      'project',
      'decision',
      'summary'
    ]).describe("The type of memory. Usually 'preference' or 'fact'."),
    memory_type: z.enum([
      'stable_preference',
      'worldview',
      'source_trust_pattern',
      'working_style',
      'product_design_principle',
      'communication_preference',
      'long_term_tool_preference',
      'information_diet'
    ]).describe("The specific classification of this memory."),
    importance: z.number().int().min(1).max(5).describe("Scale 1-5. Must be >= 4 to be saved."),
  })).describe("List of profound facts. Empty if nothing profound is found.")
});

const mergeMemorySchema = z.object({
  action: z.enum(['insert', 'merge', 'discard']).describe("Whether to insert as new, merge with existing, or discard if redundant."),
  targetId: z.string().optional().describe("If action is merge, the ID of the existing memory to replace."),
  mergedContent: z.string().optional().describe("If action is merge or insert, the final polished content of the memory."),
});

const SYSTEM_PROMPT = `Analyze the following conversation segment and extract ONLY profound, persistent truths about the user's worldview, core preferences, deep working methods, or long-term identity.

CRITICAL RULES (QUALITY GATES):
1. Extract a memory only if it would remain useful after the current project, current week, and current implementation details are forgotten.
2. DO NOT extract ephemeral facts (e.g. "User ate pizza", "User is debugging a bug", "User ran typecheck").
3. DO NOT extract simple greetings or context-dependent opinions.
4. NEVER store credentials, API keys, infrastructure details, file names, commit history, provider configurations, or implementation logs as user memory.
5. Most conversations should produce NO memories. If there is nothing profound, return an empty array [].
6. Frame facts as interpreted user structures (e.g. "User prefers AI capabilities to remain invisible in UX" instead of "User said hide the AI button").`;

export async function processMemoryJob(job: any) {
  const supabase = getSupabaseClient();
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
  // Fetch up to 30 messages to capture repetitive patterns
  const { data: messages, error: messagesError } = await supabase
    .from('muel_messages_v2')
    .select('id, role, parts, created_at')
    .eq('chat_id', chatId)
    .lte('created_at', payload.createdAt)
    .order('created_at', { ascending: false })
    .limit(30);

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

  if (!object.memories || object.memories.length === 0) return;

  const sourceUserId = chatData.source_user_id;

  // Fetch existing active memories for this user to deduplicate/merge
  const { data: userMemories } = await supabase.rpc('fetch_active_memories_by_user', {
    p_user_id: sourceUserId,
  });

  // 4. Process each candidate memory
  for (const memory of object.memories) {
    if (memory.importance < 4) {
      console.log(`[memory] Candidate rejected (low importance): ${memory.content}`);
      continue;
    }

    console.log(`[memory] Candidate extracted: ${memory.content} (importance: ${memory.importance})`);

    let finalAction = 'insert';
    let finalContent = memory.content;
    let targetId = null;

    if (userMemories && userMemories.length > 0) {
      const existingText = userMemories.map((m: any) => `ID: ${m.id}\nContent: ${m.content}`).join('\n\n');
      const { object: mergeDecision } = await generateObject({
        model,
        schema: mergeMemorySchema,
        prompt: `You are managing an AI's long-term memory for a user.
A new memory candidate has been extracted:
"${memory.content}"

Here are the user's existing memories:
${existingText}

Task:
- Choose "discard" ONLY if the existing memory already covers this exactly and the new info adds NO durable value.
- Choose "merge" ONLY if the new candidate is on the exact same axis/topic and you can safely update the existing memory's wording to encompass both. Provide 'mergedContent' and 'targetId'.
- Choose "insert" if the new candidate is related but DISTINCT (e.g. "dislikes AI-branded UX" is distinct from "values technical transparency"), or completely new. DO NOT over-merge independent preferences.`,
      });

      finalAction = mergeDecision.action;
      finalContent = mergeDecision.mergedContent || memory.content;
      targetId = mergeDecision.targetId;
    }

    if (finalAction === 'discard') {
      console.log(`[memory] Candidate discarded (redundant).`);
      continue;
    }

    // Generate embedding FIRST so if it fails, the job retries safely without partial inserts
    console.log(`[memory] Generating embedding for action=${finalAction}...`);
    const { embedding } = await embed({ model: embeddingModel, value: finalContent });

    if (finalAction === 'merge' && targetId) {
      console.log(`[memory] Merging with ${targetId}: ${finalContent}`);
      await supabase.rpc('update_muel_memory_atomic', {
        p_entry_id: targetId,
        p_content: finalContent,
        p_embedding: embedding,
        p_embedding_model: 'text-embedding-004'
      });
    } else {
      console.log(`[memory] Inserting new: ${finalContent}`);
      
      // HARD CAP: If inserting, check active memory count
      if (userMemories && userMemories.length >= 12) {
        // Find memory to archive (lowest importance, oldest)
        const toArchive = [...userMemories].sort((a, b) => {
          if (a.importance !== b.importance) return a.importance - b.importance;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        })[0];
        
        console.log(`[memory] Hard cap reached. Archiving lowest importance memory: ${toArchive.id}`);
        await supabase
          .from('muel_memory_entries')
          .update({ status: 'archived', updated_at: new Date().toISOString() })
          .eq('id', toArchive.id);
          
        // Remove from current list to keep accurate count if multiple inserts happen
        const idx = userMemories.findIndex((m: any) => m.id === toArchive.id);
        if (idx > -1) userMemories.splice(idx, 1);
      }

      const { data: newEntryId, error: insertError } = await supabase.rpc('insert_muel_memory_atomic', {
        p_chat_id: chatId,
        p_message_id: messageId,
        p_kind: memory.kind || 'preference',
        p_content: finalContent,
        p_importance: memory.importance,
        p_embedding: embedding,
        p_embedding_model: 'text-embedding-004'
      });
      
      if (insertError) {
        console.error('[memory] Failed atomic insert', insertError);
      } else if (newEntryId) {
        // Add to our list so if this job produces >1 memory, it counts towards the cap
        userMemories?.push({
          id: newEntryId,
          content: finalContent,
          importance: memory.importance,
          kind: memory.kind || 'preference',
          status: 'active',
          created_at: new Date().toISOString()
        });
      }
    }
  }
}

export async function runMemoryWorkerLoop() {
  const supabase = getSupabaseClient();
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

    // Wait before polling again (60s — jobs have a 30min delay anyway)
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}

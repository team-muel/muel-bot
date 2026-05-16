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
      'long_term_tool_preference'
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

  // Fetch existing memories for this user to deduplicate/merge
  const { data: existingMemories } = await supabase
    .from('muel_memory_entries')
    .select('id, content, importance, kind')
    .eq('muel_chats.source_user_id', sourceUserId)
    .order('created_at', { ascending: false });
    
  // Wait, joining via foreign key using postgrest is slightly different, let's fetch chats for this user first
  const { data: userChats } = await supabase
    .from('muel_chats')
    .select('id')
    .eq('source_user_id', sourceUserId);
  
  const userChatIds = userChats?.map(c => c.id) || [chatId];

  const { data: userMemories } = await supabase
    .from('muel_memory_entries')
    .select('id, content, importance, kind')
    .in('chat_id', userChatIds);

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
      const existingText = userMemories.map(m => `ID: ${m.id}\nContent: ${m.content}`).join('\n\n');
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
      await supabase
        .from('muel_memory_entries')
        .update({
          content: finalContent,
          updated_at: new Date().toISOString()
        })
        .eq('id', targetId);

      await supabase.from('muel_memory_embeddings').upsert({ memory_id: targetId, embedding, embedding_model: 'text-embedding-004' });
    } else {
      console.log(`[memory] Inserting new: ${finalContent}`);
      const { data: newEntry } = await supabase
        .from('muel_memory_entries')
        .insert({
          chat_id: chatId,
          message_id: messageId,
          kind: memory.kind || 'preference',
          content: finalContent,
          importance: memory.importance,
        })
        .select('id')
        .single();

      if (newEntry) {
        await supabase.from('muel_memory_embeddings').insert({ memory_id: newEntry.id, embedding, embedding_model: 'text-embedding-004' });
      }
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

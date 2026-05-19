import 'dotenv/config';
import { getSupabaseClient } from '../src/supabase.js';
import { summarizeCommunityFlowJob } from '../src/communityFlow.js';

const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const POLL_INTERVAL_MS = 5000;
const MAX_JOBS_PER_BATCH = 10;

async function processJob(job: any) {
  console.log(`[worker ${WORKER_ID}] Processing job ${job.id} (type: ${job.type}, attempt: ${job.attempts})`);
  const supabase = getSupabaseClient();
  
  try {
    if (job.type === 'extract_memory') {
      // Stub memory extraction
      console.log(`[worker ${WORKER_ID}] Stubbing memory extraction for payload:`, job.payload);
      
      // Simulate work
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Complete job
      const { error } = await supabase.rpc('complete_job', { p_job_id: job.id });
      if (error) throw error;
      console.log(`[worker ${WORKER_ID}] Completed job ${job.id}`);
      
    } else if (job.type === 'summarize_community_flow') {
      await summarizeCommunityFlowJob(supabase, job.payload as { signalId: string });
      const { error } = await supabase.rpc('complete_job', { p_job_id: job.id });
      if (error) throw error;
      console.log(`[worker ${WORKER_ID}] Completed community flow job ${job.id}`);
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }
  } catch (error: any) {
    console.error(`[worker ${WORKER_ID}] Failed job ${job.id}:`, error);
    // Fail job with retry delay (e.g. exponential backoff: attempt * 60 seconds)
    const delay = job.attempts * 60;
    const { error: failError } = await supabase.rpc('fail_job', { 
      p_job_id: job.id, 
      p_error: error.message || String(error), 
      p_retry_delay_seconds: delay,
      p_max_attempts: 5
    });
    if (failError) {
      console.error(`[worker ${WORKER_ID}] Failed to mark job ${job.id} as failed:`, failError);
    }
  }
}

async function tick() {
  const supabase = getSupabaseClient();
  try {
    const { data: jobs, error } = await supabase.rpc('claim_pending_jobs', {
      p_worker_id: WORKER_ID,
      p_limit: MAX_JOBS_PER_BATCH,
    });
    
    if (error) {
      console.error(`[worker ${WORKER_ID}] Error claiming jobs:`, error);
      return;
    }
    
    if (jobs && jobs.length > 0) {
      console.log(`[worker ${WORKER_ID}] Claimed ${jobs.length} jobs.`);
      await Promise.allSettled(jobs.map(processJob));
    }
  } catch (err) {
    console.error(`[worker ${WORKER_ID}] Tick failed:`, err);
  }
}

async function startWorker() {
  console.log(`[worker ${WORKER_ID}] Starting Muel Job Worker`);
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick(); // Run immediately
}

startWorker();

import 'dotenv/config';
import { getSupabaseClient } from '../src/supabase.js';

async function runTests() {
  const supabase = getSupabaseClient();
  const workerId = 'test-worker-1';
  const claimLimit = 100;
  
  // Clean up old test data if any
  const dedupeKey = `test_dedupe_${Date.now()}`;
  
  console.log('Testing Enqueue with Dedupe Key...');
  const { data: jobIdData, error: enqueueError } = await supabase.rpc('enqueue_job', {
    p_type: 'extract_memory',
    p_payload: { test: true },
    p_dedupe_key: dedupeKey
  });
  
  if (enqueueError) throw enqueueError;
  const jobId = jobIdData;
  console.log('✅ Job Enqueued:', jobId);
  
  console.log('Testing Duplicate Enqueue...');
  const { data: dupJobId, error: dupError } = await supabase.rpc('enqueue_job', {
    p_type: 'extract_memory',
    p_payload: { test: true },
    p_dedupe_key: dedupeKey
  });
  if (dupError) throw dupError;
  if (dupJobId !== jobId) throw new Error(`Duplicate enqueue returned different ID: ${dupJobId} !== ${jobId}`);
  console.log('✅ Duplicate enqueue properly handled and returned same ID.');
  
  console.log('Testing Claim...');
  const { data: claimed, error: claimError } = await supabase.rpc('claim_pending_jobs', {
    p_worker_id: workerId,
    p_limit: claimLimit
  });
  if (claimError) throw claimError;
  
  const myJob = claimed?.find((j: any) => j.id === jobId);
  if (!myJob) throw new Error('Job was not claimed!');
  if (myJob.attempts !== 1) throw new Error('Attempts should be 1');
  console.log('✅ Job Claimed. Attempts:', myJob.attempts);
  
  console.log('Testing Fail & Max Attempts (Dead-letter)...');
  // Fake fail it 4 times to hit max attempts (5)
  for (let i = 1; i <= 4; i++) {
    // Fail with 0 delay so we can claim it immediately
    await supabase.rpc('fail_job', { p_job_id: jobId, p_error: 'Test fail', p_retry_delay_seconds: 0, p_max_attempts: 5 });
    const { data: retryClaimed } = await supabase.rpc('claim_pending_jobs', { p_worker_id: workerId, p_limit: claimLimit });
    const retryJob = retryClaimed?.find((j: any) => j.id === jobId);
    if (!retryJob) throw new Error(`Failed to claim on attempt ${i+1}`);
  }
  
  // Now it's currently running with attempts = 5. Fail it one more time.
  await supabase.rpc('fail_job', { p_job_id: jobId, p_error: 'Final fail', p_retry_delay_seconds: 0, p_max_attempts: 5 });
  
  const { data: finalCheck } = await supabase
    .from('muel_jobs')
    .select('status')
    .eq('id', jobId)
    .single();
    
  if (finalCheck?.status !== 'dead') throw new Error(`Job status is ${finalCheck?.status}, expected 'dead'`);
  console.log('✅ Job correctly transitioned to "dead" state after max attempts.');
  
  console.log('Testing Stale Lock Recovery...');
  const { data: staleJobId } = await supabase.rpc('enqueue_job', {
    p_type: 'extract_memory',
    p_payload: { test: 'stale' },
    p_dedupe_key: `${dedupeKey}_stale`
  });
  
  // Claim it
  await supabase.rpc('claim_pending_jobs', { p_worker_id: workerId, p_limit: claimLimit });
  
  // Artificially change locked_at to 15 minutes ago
  await supabase.from('muel_jobs').update({
    locked_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()
  }).eq('id', staleJobId);
  
  // Try to claim again
  const { data: reclaimed } = await supabase.rpc('claim_pending_jobs', { p_worker_id: workerId, p_limit: claimLimit });
  const reclaimedJob = reclaimed?.find((j: any) => j.id === staleJobId);
  if (!reclaimedJob) throw new Error('Stale job was not reclaimed!');
  if (reclaimedJob.attempts !== 2) throw new Error('Attempts should be 2 after reclaim');
  console.log('✅ Stale lock successfully recovered.');
  
  await supabase.rpc('complete_job', { p_job_id: staleJobId });
  const { data: completedCheck } = await supabase
    .from('muel_jobs')
    .select('status')
    .eq('id', staleJobId)
    .single();
  if (completedCheck?.status !== 'done') throw new Error(`Completed job status is ${completedCheck?.status}, expected 'done'`);
  console.log('✅ Cleanup complete.');
  
  console.log('\nAll advanced Job Queue tests passed!');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});

import 'dotenv/config';
import { getSupabaseClient } from '../src/supabase.js';

async function runTests() {
  const supabase = getSupabaseClient();
  const workerId = 'test-worker-1';
  
  console.log('Testing Enqueue...');
  const { data: jobIdData, error: enqueueError } = await supabase.rpc('enqueue_job', {
    p_type: 'extract_memory',
    p_payload: { test: true }
  });
  
  if (enqueueError) throw enqueueError;
  const jobId = jobIdData;
  console.log('✅ Job Enqueued:', jobId);
  
  console.log('Testing Claim...');
  const { data: claimed, error: claimError } = await supabase.rpc('claim_pending_jobs', {
    p_worker_id: workerId,
    p_limit: 10
  });
  if (claimError) throw claimError;
  
  const myJob = claimed?.find((j: any) => j.id === jobId);
  if (!myJob) throw new Error('Job was not claimed!');
  if (myJob.attempts !== 1) throw new Error('Attempts should be 1');
  console.log('✅ Job Claimed. Attempts:', myJob.attempts);
  
  console.log('Testing Fail & Retry Delay...');
  const { error: failError } = await supabase.rpc('fail_job', {
    p_job_id: jobId,
    p_error: 'Test failure',
    p_retry_delay_seconds: 5
  });
  if (failError) throw failError;
  console.log('✅ Job marked failed with 5s delay.');
  
  // Try claiming immediately - should not claim
  const { data: claimed2 } = await supabase.rpc('claim_pending_jobs', { p_worker_id: workerId, p_limit: 10 });
  if (claimed2?.find((j: any) => j.id === jobId)) throw new Error('Job was claimed before retry delay elapsed!');
  console.log('✅ Job respects retry delay.');
  
  console.log('Waiting 6 seconds...');
  await new Promise(r => setTimeout(r, 6000));
  
  const { data: claimed3 } = await supabase.rpc('claim_pending_jobs', { p_worker_id: workerId, p_limit: 10 });
  const myJobRetry = claimed3?.find((j: any) => j.id === jobId);
  if (!myJobRetry) throw new Error('Job was not claimed after retry delay!');
  if (myJobRetry.attempts !== 2) throw new Error('Attempts should be 2');
  console.log('✅ Job claimed again! Attempts:', myJobRetry.attempts);
  
  console.log('Testing Complete...');
  const { error: completeError } = await supabase.rpc('complete_job', { p_job_id: jobId });
  if (completeError) throw completeError;
  
  const { data: finalCheck } = await supabase
    .from('muel_jobs')
    .select('status')
    .eq('id', jobId)
    .single();
    
  if (finalCheck?.status !== 'done') throw new Error('Job status is not done!');
  console.log('✅ Job completed successfully.');
  
  console.log('\nAll Job Queue tests passed!');
}

runTests().catch(console.error);

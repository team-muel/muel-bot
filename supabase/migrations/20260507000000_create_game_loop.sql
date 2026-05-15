-- Migration: Setup pg_cron to call phase-advance Edge Function periodically
-- Note: This requires the pg_net and pg_cron extensions to be enabled in your Supabase project.
-- You must uncomment and configure the webhook URL with your actual Edge Function URL and Anon Key.

/*
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Create a cron job that runs every minute to trigger the phase-advance Edge Function
-- For higher frequency, you would need to use a different scheduling mechanism,
-- such as a continuous loop within an Edge Function or an external worker.
-- Alternatively, pg_cron can be configured with a trick to run multiple times a minute,
-- but the native minimum resolution is 1 minute.

select cron.schedule(
  'invoke-phase-advance-every-minute',
  '* * * * *',
  $$
    select net.http_post(
      url:='https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/phase-advance',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer <YOUR_ANON_KEY>"}'::jsonb
    );
  $$
);
*/

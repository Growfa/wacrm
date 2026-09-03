-- ============================================================
-- 039 - Schedule the storage-gc Edge Function (nightly).
--
-- Deletes media files (chat-media, flow-media, avatars) older
-- than a year. The cleanup logic lives in a Supabase Edge
-- Function (`supabase/functions/storage-gc`); this migration
-- only *schedules* it via pg_cron + pg_net.
--
-- Secure invocation: the function validates
-- `Authorization: Bearer <service role>`. We pass that service
-- role key inline in the cron's `net.http_post` header. (It is
-- only visible to admins who can read `cron.job`, matching the
-- level of access already granted by the admin key.) The
-- `SUPABASE_SERVICE_ROLE_KEY` used for the comparison lives only
-- in the Edge Function's own runtime env, never in the repo.
--
-- Idempotent and safe to re-run.
--
-- HOW TO APPLY (Supabase Dashboard > SQL Editor):
--   1) create extension if not exists pg_cron;   -- usually pre-enabled
--   2) create extension if not exists pg_net;    -- usually pre-enabled
--   3) Replace <YOUR_SERVICE_ROLE_KEY> below with your real key,
--      then run the whole file.
-- ============================================================

-- 1) Unschedule any previous version of the job (idempotent).
select cron.unschedule('storage-gc-nightly')
where exists (select 1 from cron.job where jobname = 'storage-gc-nightly');

-- 2) Register the daily schedule: 03:10 server time, POST to the
--    storage-gc Edge Function with the service role as a bearer token.
select cron.schedule(
  'storage-gc-nightly',
  '10 3 * * *',  -- every day at 03:10
  $$
  select
    net.http_post(
      url := 'https://iisrrjxxmiyuwuedyoko.supabase.co/functions/v1/storage-gc',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <YOUR_SERVICE_ROLE_KEY>'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    ) as request_id;
  $$
);

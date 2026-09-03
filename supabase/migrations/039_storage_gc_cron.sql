-- ============================================================
-- 039 - Schedule the storage-gc Edge Function (nightly).
--
-- Deletes media files (chat-media, flow-media, avatars) older
-- than a year. The cleanup itself lives in a Supabase Edge
-- Function (`supabase/functions/storage-gc`); this migration
-- only *schedules* it via pg_cron + pg_net.
--
-- Secure invocation:
--   - The function validates `Authorization: Bearer <service role>`.
--   - We store the service role key in the Postgres Vault (encrypted
--     at rest) and pull it out only inside the cron's `net.http_post`
--     header, so the secret never appears in plaintext in the job.
--
-- Secrets the DBA must insert first (run once, in the SQL editor):
--   insert into vault.secrets (name, secret) values
--     ('storage_gc_project_url', 'https://iisrrjxxmiyuwuedyoko.supabase.co'),
--     ('storage_gc_function_url', 'https://iisrrjxxmiyuwuedyoko.supabase.co/functions/v1/storage-gc'),
--     ('storage_gc_service_role', '<YOUR_SERVICE_ROLE_KEY>');
--
-- This migration is idempotent and safe to re-run.
-- ============================================================

-- 1) Register the nightly job. If a previous version exists, adopt it
--    (cron.unschedule is idempotent, so this keeps re-runs clean).
select cron.unschedule('storage-gc-nightly')
where exists (select 1 from cron.job where jobname = 'storage-gc-nightly');

-- 2) Deploy the schedule: 03:10 every day, invoke the storage-gc
--    function with the service role as a bearer token.
select cron.schedule(
  'storage-gc-nightly',
  '10 3 * * *',  -- every day at 03:10 server time
  $$
  select
    net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'storage_gc_function_url'
        limit 1
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization',
        'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'storage_gc_service_role'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    ) as request_id;
  $$
);

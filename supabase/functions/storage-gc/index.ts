// ============================================================
// storage-gc — Delete media files older than 1 year.
//
// A cron (see supabase/migrations for the schedule) invokes
// this Edge Function on a daily schedule. It walks every storage
// bucket wacrm uses (chat-media, flow-media, avatars) and removes
// objects whose `created_at` is older than RETENTION_DAYS - the
// "after one year, delete that media" requirement.
//
// Deletes go through the Storage REST API via the official SDK
// (storage.from().remove()) — we NEVER touch storage.objects rows
// directly, which is the supported way to remove objects.
//
// Bounded + idempotent: only a limited number of objects are
// removed per invocation, and it deletes what it lists (no offset),
// so the next run simply resumes where this one stopped.
//
// Secured by requiring the SERVICE_ROLE_KEY as a bearer token.
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const RETENTION_DAYS = 365;
const MAX_DELETES_PER_RUN = 200;
const LIST_PAGE = 100;

const BUCKETS = ["chat-media", "flow-media", "avatars"];

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const client = createClient(PROJECT_URL, ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
});

const cutoff = (days: number, now = new Date()): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/**
 * Recursively collect file objects under a prefix, filtering to the
 * ones older than `cutoffDate`. `storage.list` returns folders as
 * items with `id === null`.
 */
async function collectExpired(
  bucket: string,
  prefix: string,
  cutoffDate: Date,
  acc: { name: string; ageDays: number }[],
): Promise<void> {
  const { data, error } = await client.storage
    .from(bucket)
    .list(prefix, { limit: LIST_PAGE });

  if (error) throw error;
  if (!data) return;

  for (const item of data) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) {
      // Nested folder — walk into it.
      await collectExpired(bucket, path, cutoffDate, acc);
      continue;
    }
    const created = item.created_at ? new Date(item.created_at) : null;
    if (created && created < cutoffDate) {
      const ageDays = Math.floor(
        (Date.now() - created.getTime()) / (24 * 60 * 60 * 1000),
      );
      acc.push({ name: path, ageDays });
    }
  }
}

Deno.serve(async (req) => {
  // Authorize: the cron sends our SERVICE_ROLE_KEY as a bearer token.
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!SERVICE_ROLE_KEY || token !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cutoffDate = cutoff(RETENTION_DAYS);
  const total = { scanned: 0, expired: 0, removed: 0 };
  const failures: string[] = [];

  for (const bucket of BUCKETS) {
    if (total.removed >= MAX_DELETES_PER_RUN) break;

    const expired: { name: string; ageDays: number }[] = [];
    try {
      await collectExpired(bucket, "", cutoffDate, expired);
    } catch (err) {
      failures.push(`${bucket}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    total.scanned += expired.length;
    total.expired += expired.length;

    const batch = expired.slice(0, MAX_DELETES_PER_RUN - total.removed);
    if (batch.length === 0) continue;

    const { error } = await client.storage
      .from(bucket)
      .remove(batch.map((o) => o.name));

    if (error) {
      failures.push(`${bucket}: ${error.message}`);
      continue;
    }

    total.removed += batch.length;
  }

  return Response.json(
    {
      ...total,
      retentionDays: RETENTION_DAYS,
      cutoff: cutoffDate.toISOString(),
      failures,
    },
    { status: 200 },
  );
});

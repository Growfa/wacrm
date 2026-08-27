// ============================================================
// GET /api/chatwoot/debug — diagnostic endpoint for the Chatwoot
// gateway integration. Runs a battery of tests to identify why
// inbound messages may not be syncing.
//
// Admin-only. Returns a JSON object with per-test results.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  normalizeBaseUrl,
  listAccountWebhooks,
  listInboxes,
  type ChatwootEndpoint,
} from '@/lib/chatwoot/api'
import { verifyChatwootSignature } from '@/lib/chatwoot/webhook'
import crypto from 'node:crypto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface TestResult {
  passed: boolean
  message: string
  details?: unknown
}

function mask(value: string | undefined | null, keep = 4): string {
  if (!value) return '(not set)'
  if (value.length <= keep) return '*'.repeat(value.length)
  return value.slice(0, keep) + '*'.repeat(Math.min(value.length - keep, 20))
}

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')

    const results: Record<string, TestResult> = {}

    // The secret the fork reports for our webhook (Test 4), so Test 5
    // can say decisively whether it matches what is stored in the DB.
    let forkSecret: string | null = null

    // ---- Test 1: Environment variables ----
    const baseUrl = normalizeBaseUrl(process.env.CHATWOOT_BASE_URL?.trim() ?? '')
    const accountIdRaw = Number(process.env.CHATWOOT_ACCOUNT_ID)
    const accessToken = process.env.CHATWOOT_ACCESS_TOKEN?.trim() ?? ''
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? ''

    results.env_vars = {
      passed: !!(baseUrl && Number.isInteger(accountIdRaw) && accountIdRaw > 0 && accessToken),
      message: !baseUrl
        ? 'CHATWOOT_BASE_URL is missing or invalid'
        : !accountIdRaw || accountIdRaw <= 0
          ? 'CHATWOOT_ACCOUNT_ID is missing or not a positive integer'
          : !accessToken
            ? 'CHATWOOT_ACCESS_TOKEN is missing'
            : 'All env vars present',
      details: {
        CHATWOOT_BASE_URL: baseUrl || '(missing)',
        CHATWOOT_ACCOUNT_ID: accountIdRaw || '(missing)',
        CHATWOOT_ACCESS_TOKEN: mask(accessToken),
        NEXT_PUBLIC_SITE_URL: siteUrl || '(not set — webhook URL will use request headers)',
      },
    }

    if (!results.env_vars.passed) {
      return NextResponse.json({ results, summary: 'Cannot proceed: env vars incomplete' })
    }

    const endpoint: ChatwootEndpoint = {
      baseUrl: baseUrl!,
      chatwootAccountId: accountIdRaw,
      accessToken,
    }

    // ---- Test 2: DB connection row ----
    const { data: connection, error: connError } = await supabaseAdmin()
      .from('chatwoot_connections')
      .select('id, base_url, chatwoot_account_id, inbox_id, inbox_name, inbox_phone, status, webhook_secret, created_by, last_verified_at')
      .eq('account_id', accountId)
      .maybeSingle()

    results.db_connection = {
      passed: !connError && !!connection,
      message: connError
        ? `DB error: ${connError.message}`
        : connection
          ? `Found connection (status: ${connection.status}, inbox_id: ${connection.inbox_id ?? 'null'})`
          : 'No chatwoot_connections row for this account',
      details: connection
        ? {
            id: connection.id,
            status: connection.status,
            inbox_id: connection.inbox_id,
            inbox_name: connection.inbox_name,
            inbox_phone: connection.inbox_phone,
            last_verified_at: connection.last_verified_at,
            has_webhook_secret: !!connection.webhook_secret,
          }
        : undefined,
    }

    if (!results.db_connection.passed || !connection) {
      return NextResponse.json({ results, summary: 'Cannot proceed: no connection row' })
    }

    // ---- Test 3: Chatwoot API reachability ----
    let profileData: unknown = null
    try {
      const url = `${baseUrl}/api/v1/profile`
      const resp = await fetch(url, {
        headers: { api_access_token: accessToken },
        signal: AbortSignal.timeout(10_000),
      })
      if (resp.ok) {
        profileData = await resp.json()
        results.api_reachability = {
          passed: true,
          message: `Chatwoot API reachable at ${baseUrl}`,
          details: { status: resp.status },
        }
      } else {
        results.api_reachability = {
          passed: false,
          message: `Chatwoot API returned ${resp.status}: ${resp.statusText}`,
        }
      }
    } catch (err) {
      results.api_reachability = {
        passed: false,
        message: `Cannot reach Chatwoot at ${baseUrl}: ${err instanceof Error ? err.message : err}`,
      }
    }

    if (!results.api_reachability.passed) {
      return NextResponse.json({ results, summary: 'Cannot proceed: Chatwoot unreachable' })
    }

    // ---- Test 4: Webhook registration check ----
    let webhookResults: TestResult
    try {
      const hooks = await listAccountWebhooks(endpoint)
      const siteBase = siteUrl
        ? siteUrl.replace(/\/+$/, '')
        : '(no NEXT_PUBLIC_SITE_URL — cannot match by URL)'

      // Try to find our webhook by matching the path pattern
      let ourHook: { id: number; url: string; secret?: string } | null = null
      if (connection.id) {
        const expectedPath = `/api/chatwoot/webhook/${connection.id}`
        for (const hook of hooks) {
          try {
            const hookPath = new URL(hook.url).pathname.replace(/\/+$/, '')
            if (hookPath === expectedPath) {
              ourHook = hook
              break
            }
          } catch {
            // Hook URL malformed, skip
          }
        }
      }

      const hasSecret = ourHook?.secret
        ? true
        : false

      // Store the fork's actual secret so Test 5 can compare it against
      // what is decrypted from the DB row.
      forkSecret = ourHook?.secret ?? null

      webhookResults = {
        passed: !!ourHook,
        message: ourHook
          ? `Found matching webhook (id: ${ourHook.id}) secret_len=${ourHook?.secret?.length ?? 0}`
          : `No webhook found pointing at /api/chatwoot/webhook/${connection.id}. Registered webhooks: ${hooks.length}`,
        details: {
          total_webhooks: hooks.length,
          all_webhooks: hooks.map(h => ({ id: h.id, url: h.url, has_secret: !!h.secret, secret_len: h.secret?.length ?? 0 })),
          our_webhook: ourHook
            ? { id: ourHook.id, url: ourHook.url, has_secret: hasSecret, secret_len: ourHook?.secret?.length ?? 0, secret_value: hasSecret ? mask(ourHook!.secret) : '(MISSING — HMAC will fail)' }
            : null,
          site_url: siteBase,
        },
      }
    } catch (err) {
      webhookResults = {
        passed: false,
        message: `Failed to list webhooks: ${err instanceof Error ? err.message : err}`,
      }
    }
    results.webhook_registration = webhookResults

    // ---- Test 5: HMAC secret verification ----
    let secretTest: TestResult
    try {
      // Decrypt the stored secret
      const storedSecret = decrypt(connection.webhook_secret)

      // Compare against what the fork reports for this webhook.
      const matchesFork =
        forkSecret !== null && forkSecret !== undefined && forkSecret === storedSecret

      // Generate a test HMAC signature
      const testBody = JSON.stringify({ test: true, event: 'message_created', id: 0 })
      const testTimestamp = String(Math.floor(Date.now() / 1000))
      const testSignature = 'sha256=' + crypto
        .createHmac('sha256', storedSecret)
        .update(`${testTimestamp}.${testBody}`)
        .digest('hex')

      // Verify it ourselves
      const verified = verifyChatwootSignature(testBody, testTimestamp, testSignature, storedSecret)

      secretTest = {
        passed: verified,
        message: matchesFork
          ? 'Stored secret MATCHES the fork secret and produces valid HMAC'
          : forkSecret === null
            ? 'Stored secret decrypts, but the fork returned no secret to compare (cannot confirm match)'
            : 'Stored secret does NOT match the fork secret — this is why HMAC fails. Re-register so the DB stores the fork secret.',
        details: {
          secret_length: storedSecret.length,
          secret_preview: mask(storedSecret, 4),
          fork_secret_length: forkSecret?.length ?? 0,
          fork_secret_preview: forkSecret ? mask(forkSecret, 4) : '(none)',
          secrets_match: matchesFork,
          verification: verified ? 'PASS' : 'FAIL',
        },
      }
    } catch (err) {
      secretTest = {
        passed: false,
        message: `Cannot decrypt stored webhook_secret: ${err instanceof Error ? err.message : err}. This means HMAC verification will always fail.`,
      }
    }
    results.hmac_secret = secretTest

    // ---- Test 6: Inbox binding check ----
    if (connection.inbox_id) {
      try {
        const inboxes = await listInboxes(endpoint)
        const boundInbox = inboxes.find(i => i.id === connection.inbox_id)

        results.inbox_binding = {
          passed: !!boundInbox,
          message: boundInbox
            ? `Inbox #${connection.inbox_id} "${boundInbox.name}" exists on Chatwoot`
            : `Inbox #${connection.inbox_id} NOT FOUND on Chatwoot — it may have been deleted`,
          details: boundInbox
            ? { id: boundInbox.id, name: boundInbox.name, channel_type: boundInbox.channel_type }
            : { available_inboxes: inboxes.map(i => ({ id: i.id, name: i.name })) },
        }
      } catch (err) {
        results.inbox_binding = {
          passed: false,
          message: `Failed to check inbox: ${err instanceof Error ? err.message : err}`,
        }
      }
    } else {
      results.inbox_binding = {
        passed: false,
        message: 'No inbox_id bound — pair a WhatsApp number first',
      }
    }

    // ---- Test 7: Webhook URL reachability test ----
    if (siteUrl) {
      const webhookUrl = `${siteUrl.replace(/\/+$/, '')}/api/chatwoot/webhook/${connection.id}`
      try {
        const resp = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ test: true }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'follow',
        })
        // We expect 400 (invalid JSON/signature) or 404 (unknown connection)
        // A 200 means the route is reachable. Connection refused = not reachable.
        results.webhook_reachability = {
          passed: resp.status !== 0 && resp.status < 500,
          message: `Webhook URL responded with HTTP ${resp.status} — endpoint is reachable`,
          details: { url: webhookUrl, status: resp.status },
        }
      } catch (err) {
        results.webhook_reachability = {
          passed: false,
          message: `Cannot reach webhook URL: ${err instanceof Error ? err.message : err}. Chatwoot cannot deliver events.`,
          details: { url: webhookUrl },
        }
      }
    } else {
      results.webhook_reachability = {
        passed: false,
        message: 'NEXT_PUBLIC_SITE_URL not set — cannot test webhook reachability',
      }
    }

    // ---- Summary ----
    const allPassed = Object.values(results).every(r => r.passed)
    const failedTests = Object.entries(results).filter(([, r]) => !r.passed).map(([k]) => k)

    return NextResponse.json({
      summary: allPassed
        ? 'All checks passed — if messages still don\'t arrive, check Chatwoot\'s webhook delivery logs'
        : `Issues found: ${failedTests.join(', ')}`,
      all_passed: allPassed,
      failed_tests: failedTests,
      results,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

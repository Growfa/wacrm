// ============================================================
// /api/chatwoot/config — the account's Chatwoot gateway connection
// (migration 037).
//
// Gateway credentials come from SERVER ENV VARS, not the UI:
//   CHATWOOT_BASE_URL / CHATWOOT_ACCOUNT_ID / CHATWOOT_ACCESS_TOKEN
//   (+ optional CHATWOOT_WEBHOOK_SECRET override)
//
//   GET    any member → masked connection state for the settings UI,
//          plus gateway_configured so the client knows whether the
//          operator still needs to set the env vars. Never returns
//          the access token or webhook secret.
//
//   POST   admin only, no body. Reads the env vars, re-verifies the
//          Application-API token against the instance, encrypts +
//          upserts the row (credential columns are materialized from
//          env on every connect, so rotation = edit .env.local +
//          reconnect; inbox_* fields are preserved), then registers a
//          per-connection account webhook pointing back at
//          /api/chatwoot/webhook/{id}. Registration is best-effort:
//          a failure saves the connection but flags it so the UI can
//          show manual-setup instructions. The webhook HMAC secret is
//          generated server-side unless CHATWOOT_WEBHOOK_SECRET
//          overrides it.
//
//   DELETE admin only. Removes the connection and best-effort deletes
//          its webhook registration on the Chatwoot side. Stored
//          messages survive (they're plain rows); only future gateway
//          traffic stops.
// ============================================================

import { randomBytes } from 'crypto'
import { NextResponse } from 'next/server'
import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import {
  verifyCredentials,
  registerAccountWebhook,
  listAccountWebhooks,
  deleteWebhooksByUrl,
  ChatwootApiError,
  normalizeBaseUrl,
} from '@/lib/chatwoot/api'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * Gateway credentials come from server env vars so operators configure
 * the Chatwoot instance once and users only ever pair numbers.
 * Returns null when any of the three is missing/invalid.
 */
function gatewayFromEnv() {
  const baseUrl = normalizeBaseUrl(
    process.env.CHATWOOT_BASE_URL?.trim() ?? ''
  )
  const accountIdRaw = Number(process.env.CHATWOOT_ACCOUNT_ID)
  const accessToken = process.env.CHATWOOT_ACCESS_TOKEN?.trim() ?? ''
  if (
    !baseUrl ||
    !Number.isInteger(accountIdRaw) ||
    accountIdRaw <= 0 ||
    !accessToken
  ) {
    return null
  }
  return { baseUrl, chatwootAccountId: accountIdRaw, accessToken }
}

/**
 * Public base URL for webhook registration. Precedence mirrors the
 * invitations route: NEXT_PUBLIC_SITE_URL (explicit config, required
 * behind proxies) → forwarded headers → request URL origin. The last
 * two are best-effort fallbacks for local dev.
 */
function resolveWebhookBase(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto =
    request.headers.get('x-forwarded-proto') ??
    new URL(request.url).protocol.replace(':', '')
  if (host) return `${proto}://${host}`
  return new URL(request.url).origin
}

/** GET /api/chatwoot/config — masked state for the settings card. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('chatwoot_connections')
      .select(
        'id, base_url, chatwoot_account_id, inbox_id, inbox_name, inbox_phone, status, last_verified_at, created_at'
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[chatwoot/config GET] fetch error:', error)
      return NextResponse.json(
        {
          error: 'Failed to load Chatwoot configuration',
          // Surface the raw DB message — a missing migration (table
          // not created) shows up here and admins can act on it.
          detail: error.message,
        },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json({
        connected: false,
        gateway_configured: gatewayFromEnv() !== null,
      })
    }

    return NextResponse.json({
      connected: data.status === 'connected',
      gateway_configured: true,
      ...data,
      // The exact URL to paste into Chatwoot's webhook settings when
      // auto-registration isn't available.
      webhook_url: `/api/chatwoot/webhook/${data.id}`,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/chatwoot/config — save (and verify) the connection using
 * the CHATWOOT_* env vars. Takes no body.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`chatwoot-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const gateway = gatewayFromEnv()
    if (!gateway) {
      return bad(
        'Chatwoot gateway is not configured on this server. Set CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID and CHATWOOT_ACCESS_TOKEN.'
      )
    }
    const endpoint = gateway

    // The webhook HMAC secret signs OUR inbound deliveries; generate
    // one unless the operator pinned it via env.
    const webhookSecret =
      process.env.CHATWOOT_WEBHOOK_SECRET?.trim() ||
      randomBytes(24).toString('hex')

    // Verify BEFORE persisting — same discipline as whatsapp_config
    // (never store credentials the provider already rejected).
    try {
      await verifyCredentials(endpoint)
    } catch (err) {
      if (err instanceof ChatwootApiError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    let encryptedToken: string
    let encryptedSecret: string
    try {
      encryptedToken = encrypt(endpoint.accessToken)
      encryptedSecret = encrypt(webhookSecret)
    } catch (err) {
      console.error('[chatwoot/config POST] encryption failed:', err)
      return bad(
        'Failed to encrypt credentials. Check that ENCRYPTION_KEY is a valid 64-character hex string.'
      )
    }

    const now = new Date().toISOString()

    // Upsert on the UNIQUE(account_id) constraint so a re-save updates
    // in place (keeping the row id — and thus the webhook URL — stable).
    // inbox_* columns are deliberately omitted: untouched on UPDATE so
    // re-preparing never wipes a paired number, NULL on fresh INSERT.
    const { data: saved, error: upsertError } = await supabase
      .from('chatwoot_connections')
      .upsert(
        {
          account_id: accountId,
          created_by: userId,
          base_url: endpoint.baseUrl,
          chatwoot_account_id: endpoint.chatwootAccountId,
          api_access_token: encryptedToken,
          webhook_secret: encryptedSecret,
          status: 'connected',
          last_verified_at: now,
          updated_at: now,
        },
        { onConflict: 'account_id' }
      )
      .select('id')
      .single()

    if (upsertError || !saved) {
      console.error('[chatwoot/config POST] upsert failed:', upsertError)
      return NextResponse.json(
        {
          error: 'Failed to save configuration',
          detail:
            upsertError?.message ?? 'No row returned from the database.',
        },
        { status: 500 }
      )
    }

    // Register the account webhook pointing at this connection's
    // private URL. Best-effort: older forks may not accept `secret`
    // or the endpoint may differ — surface the outcome either way.
    const webhookUrl = `${resolveWebhookBase(request)}/api/chatwoot/webhook/${saved.id}`
    let webhookRegistered = false
    let webhookError: string | null = null
    let secretMismatchWarning: string | null = null
    try {
      await deleteWebhooksByUrl(endpoint, webhookUrl)
      const registered = await registerAccountWebhook(endpoint, webhookUrl, webhookSecret)
      webhookRegistered = true

      // The fazer.ai fork (and possibly other versions) ignores the
      // secret we send at creation time and generates its own, signing
      // deliveries with THAT secret. The list endpoint is the source of
      // truth for what the fork actually uses — so we re-read it after
      // creation and treat the fork-reported secret as authoritative.
      // (The `registered.secret` from the POST response is a first
      // guess, but the list reflects the real persisted value.)
      let actualSecret = registered.secret
      try {
        const hooks = await listAccountWebhooks(endpoint)
        let targetPath: string | null = null
        try { targetPath = new URL(webhookUrl).pathname.replace(/\/+$/, '') } catch { /* noop */ }

        // Match by webhook ID first, then fall back to matching by URL
        // path alone (in case the POST returned an unexpected id).
        const byId = hooks.find((h) => h.id === registered.id)
        const match = byId ?? hooks.find((h) => {
          if (!targetPath) return false
          try { return new URL(h.url).pathname.replace(/\/+$/, '') === targetPath } catch { /* noop */ }
          return false
        })

        if (match?.secret) {
          actualSecret = match.secret
          console.log('[chatwoot/config POST] resolved webhook secret from list endpoint')
        } else if (match && !match.secret) {
          // The webhook exists but the fork returned no secret at all.
          console.warn(
            '[chatwoot/config POST] webhook found but has NO secret —',
            'HMAC verification will fail. Set CHATWOOT_WEBHOOK_SECRET env var',
            'to a fixed value and configure the same value in Chatwoot.'
          )
          secretMismatchWarning =
            'The Chatwoot instance did not return a webhook secret. ' +
            'HMAC signature verification may fail. Set CHATWOOT_WEBHOOK_SECRET ' +
            'to a fixed value in your .env and re-save.'
        } else if (!byId) {
          console.warn(
            '[chatwoot/config POST] could not find registered webhook in list —',
            `registered id=${registered.id}, list returned ${hooks.length} hooks`
          )
        }
      } catch (listErr) {
        console.warn(
          '[chatwoot/config POST] failed to fetch webhook list for secret recovery:',
          listErr instanceof Error ? listErr.message : listErr
        )
      }

      // If the actual secret differs from what we just encrypted and
      // stored, re-encrypt and update the row so the webhook route
      // can verify incoming Chatwoot signatures.
      if (actualSecret && actualSecret !== webhookSecret) {
        console.log('[chatwoot/config POST] secret mismatch — updating stored secret to match Chatwoot')
        const actualEncrypted = encrypt(actualSecret)
        await supabase
          .from('chatwoot_connections')
          .update({ webhook_secret: actualEncrypted, updated_at: new Date().toISOString() })
          .eq('id', saved.id)
      } else if (!actualSecret && !secretMismatchWarning) {
        // No secret from the POST response AND no secret from the list.
        // The only option is the secret we generated — it will only work
        // if the fork actually honours the secret sent at creation time.
        console.warn(
          '[chatwoot/config POST] no secret recovered — HMAC verification',
          'depends on whether the fork honours the registration-time secret.'
        )
      }
    } catch (err) {
      webhookError =
        err instanceof Error ? err.message : 'Unknown Chatwoot API error'
      console.warn(
        '[chatwoot/config POST] webhook registration failed (non-fatal):',
        webhookError
      )
    }

    return NextResponse.json({
      success: true,
      id: saved.id,
      webhook_url: webhookUrl,
      webhook_registered: webhookRegistered,
      webhook_error: webhookError,
      secret_mismatch_warning: secretMismatchWarning,
    })
  } catch (err) {
    if (err instanceof ChatwootApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}

/** DELETE /api/chatwoot/config — disconnect the gateway. Admin only. */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    // Load first so we can clean up the remote webhook registration.
    const { data: existing } = await supabase
      .from('chatwoot_connections')
      .select('id, base_url, chatwoot_account_id, api_access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ success: true })
    }

    // Best-effort remote cleanup. Needs the decrypted token, which may
    // itself fail after an ENCRYPTION_KEY rotation — in that case the
    // stale registration keeps receiving (now-401ing) deliveries until
    // removed by hand in Chatwoot's UI.
    try {
      await deleteWebhooksByUrl(
        {
          baseUrl: existing.base_url,
          chatwootAccountId: existing.chatwoot_account_id,
          accessToken: decrypt(existing.api_access_token),
        },
        `${resolveWebhookBase(request)}/api/chatwoot/webhook/${existing.id}`
      )
    } catch (err) {
      console.warn(
        '[chatwoot/config DELETE] webhook cleanup skipped:',
        err instanceof Error ? err.message : err
      )
    }

    const { error: deleteError } = await supabase
      .from('chatwoot_connections')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('[chatwoot/config DELETE] failed:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

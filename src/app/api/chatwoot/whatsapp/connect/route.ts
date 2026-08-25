// ============================================================
// /api/chatwoot/whatsapp/connect — pair a WhatsApp number on the
// gateway's Baileys provider (unofficial channel, migration 037).
//
// Creates (or reuses) a Channel::Whatsapp inbox with provider
// 'baileys', binds it to the account's chatwoot_connections row so
// inbound routing works immediately, then kicks off the pairing
// session. The QR code itself is NOT returned here — it appears in
// Chatwoot's provider_connection moments later; the settings UI polls
// /api/chatwoot/whatsapp/status until connection === 'open'.
//
// Re-invoking with the same number skips inbox creation and simply
// restarts the session — that is how the UI regenerates an expired
// QR. The binding is probed first: if that inbox was deleted on the
// Chatwoot dashboard, the pairing self-heals by creating a fresh one.
// A DIFFERENT number creates another inbox. Numbers are globally
// unique per Chatwoot instance: if some OTHER inbox already claims
// the number, this returns 409 and pairs nothing — the CRM flow is
// end-to-end (create + pair), so pre-existing inboxes must be removed
// there first rather than silently adopted.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { isValidE164 } from '@/lib/whatsapp/phone-utils'
import { getActiveChatwootConnection } from '@/lib/chatwoot/send'
import {
  createBaileysInbox,
  setupInboxProvider,
  listInboxes,
  getInboxProviderState,
  ChatwootApiError,
} from '@/lib/chatwoot/api'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** Strip formatting and force the leading + Chatwoot expects. */
function normalizeToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!isValidE164(`+${digits}`)) return null
  return `+${digits}`
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(
      `chatwoot-wa-connect:${userId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const phoneNumber = normalizeToE164(String(body.phone_number ?? ''))
    if (!phoneNumber) {
      return bad(
        'phone_number must be a valid E.164 number (e.g. +5511999999999)'
      )
    }
    const name =
      // The settings wizard sends `inbox_name`; accept the bare `name`
      // too so older clients / API users don't silently lose it (the
      // inbox then falls back to "WhatsApp <number>").
      typeof body.inbox_name === 'string' && body.inbox_name.trim()
        ? body.inbox_name.trim().slice(0, 80)
        : typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 80)
          : undefined

    const connection = await getActiveChatwootConnection(supabase, accountId)
    if (!connection) {
      return bad('Configure the Chatwoot gateway before pairing a number')
    }

    // Same number already bound → this is a re-pair / QR refresh, not
    // a new inbox. Anything else (first run or number change) goes
    // through creation.
    let inboxId = connection.inboxId ?? null
    let sameNumber =
      inboxId !== null &&
      phoneNumber.replace(/\D/g, '') ===
        (connection.inboxPhone ?? '').replace(/\D/g, '')

    // The binding can go STALE: an admin may delete the inbox on the
    // Chatwoot dashboard at any moment. Blindly restarting the session
    // would 404 forever on the ghost inbox. Probe it first — gone means
    // fall through to full creation (which rebinds the row).
    if (sameNumber) {
      try {
        await getInboxProviderState(connection, inboxId!)
      } catch (err) {
        if (err instanceof ChatwootApiError && err.status === 404) {
          console.warn(
            '[chatwoot/wa/connect] bound inbox no longer exists on the instance — recreating'
          )
          sameNumber = false
          inboxId = null
        } else {
          throw err
        }
      }
    }

    if (!sameNumber) {
      // Instance-wide duplicate check. listInboxes filters to WhatsApp
      // channels when any exist, which is exactly the set that could
      // claim this phone number.
      const existing = await listInboxes(connection)
      const clash = existing.find(
        (inbox) =>
          (inbox.phone_number ?? '').replace(/\D/g, '') ===
          phoneNumber.replace(/\D/g, '')
      )
      if (clash) {
        return NextResponse.json(
          {
            error:
              `This number is already registered as Chatwoot inbox "${clash.name}" (#${clash.id}). ` +
              'Remove it from the Chatwoot dashboard or use a different number.',
          },
          { status: 409 }
        )
      }

      const created = await createBaileysInbox(connection, {
        phoneNumber,
        name,
      })
      if (!created.id) return bad('Chatwoot returned an invalid inbox payload')

      const { error: bindError } = await supabase
        .from('chatwoot_connections')
        .update({
          inbox_id: created.id,
          inbox_name: created.name || name || `WhatsApp ${phoneNumber}`,
          inbox_phone: phoneNumber,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
      if (bindError) {
        console.error('[chatwoot/wa/connect] bind failed:', bindError)
        // The inbox exists remotely but isn't routed yet — surface the
        // failure rather than pretending pairing can complete.
        return NextResponse.json(
          { error: 'Failed to bind the new inbox to this account' },
          { status: 500 }
        )
      }
      inboxId = created.id
    }

    if (inboxId === null) {
      return bad('No inbox is bound to this connection')
    }

    // Kick off (or refresh) the Baileys session. Errors here leave the
    // inbox bound — the UI offers a retry, which lands back on this
    // same code path.
    await setupInboxProvider(connection, inboxId)

    return NextResponse.json({ success: true, inbox_id: inboxId })
  } catch (err) {
    if (err instanceof ChatwootApiError) {
      // Pass through verbatim — duplicate-number 422s and provider
      // hiccups carry operator-fixable messages.
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}

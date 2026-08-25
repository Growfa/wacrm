// ============================================================
// /api/chatwoot/whatsapp/status — poll the Baileys session state for
// the account's bound inbox (unofficial channel, migration 037).
//
// The QR pairing flow is asynchronous: POST .../connect starts the
// session, then baileys-api pushes connection updates into Chatwoot,
// which stores them in the inbox's provider_connection blob. This
// route surfaces that blob to the settings wizard:
//
//   { pairing: 'none' }                        no gateway / no inbox
//   { pairing: 'pending', qr_data_url?, error?,
//     connection_state? }                      scan me / waiting / retry
//   { pairing: 'open', connection_state: 'open' }  paired & live
//
// qr_data_url is a ready-to-render PNG data URL that Chatwoot only
// includes in responses to ADMINISTRATOR tokens — our stored token
// qualifies, and we only relay it to admins of the wacrm account.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getActiveChatwootConnection } from '@/lib/chatwoot/send'
import {
  getInboxProviderState,
  ChatwootApiError,
} from '@/lib/chatwoot/api'

export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(
      `chatwoot-wa-status:${userId}`,
      RATE_LIMITS.chatwootPairStatus
    )
    if (!limit.success) return rateLimitResponse(limit)

    const connection = await getActiveChatwootConnection(supabase, accountId)
    if (!connection || connection.inboxId === null) {
      return NextResponse.json({ pairing: 'none' })
    }

    const state = await getInboxProviderState(connection, connection.inboxId)

    return NextResponse.json({
      pairing: state.connection === 'open' ? 'open' : 'pending',
      inbox_id: connection.inboxId,
      phone_number: connection.inboxPhone,
      connection_state: state.connection ?? null,
      // Only present while a pairing is waiting on a scan.
      qr_data_url: state.qrDataUrl ?? null,
      error: state.error ?? null,
    })
  } catch (err) {
    if (err instanceof ChatwootApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}

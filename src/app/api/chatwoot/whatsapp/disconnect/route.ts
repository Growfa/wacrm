// ============================================================
// /api/chatwoot/whatsapp/disconnect — log the bound inbox's WhatsApp
// session out at the baileys-api (unofficial channel, migration 037).
//
// Deliberately narrower than DELETE /api/chatwoot/config: this drops
// the WhatsApp SESSION only (the number stops being reachable), while
// the gateway configuration and inbox binding survive so the same
// number can be re-paired with one click. Fail-open, mirroring the
// upstream controller — a provider that refuses to let go must not
// leave the UI claiming it can't disconnect.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getActiveChatwootConnection } from '@/lib/chatwoot/send'
import { disconnectInboxProvider } from '@/lib/chatwoot/api'

export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(
      `chatwoot-wa-disconnect:${userId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const connection = await getActiveChatwootConnection(supabase, accountId)
    if (!connection || connection.inboxId === null) {
      // Nothing bound → already disconnected as far as we're concerned.
      return NextResponse.json({ success: true })
    }

    await disconnectInboxProvider(connection, connection.inboxId)

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

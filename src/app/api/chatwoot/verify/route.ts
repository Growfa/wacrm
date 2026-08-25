// ============================================================
// POST /api/chatwoot/verify — credential pre-flight for the Chatwoot
// gateway settings form (admin only).
//
// Validates the Application-API token against the instance (GET
// /profile) and returns the inboxes the token can see so the admin
// picks the WhatsApp inbox to bind. Nothing is persisted here; the
// config POST re-verifies server-side before saving.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  verifyCredentials,
  listInboxes,
  ChatwootApiError,
  normalizeBaseUrl,
} from '@/lib/chatwoot/api'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

export async function POST(request: Request) {
  try {
    const { userId } = await requireRole('admin')

    const limit = checkRateLimit(`chatwoot-verify:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const baseUrl = normalizeBaseUrl(String(body.base_url ?? ''))
    const chatwootAccountId = Number(body.chatwoot_account_id)
    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''

    if (!baseUrl) return bad('base_url must be a valid http(s) URL')
    if (!Number.isInteger(chatwootAccountId) || chatwootAccountId <= 0) {
      return bad('chatwoot_account_id must be a positive integer')
    }
    if (!accessToken) return bad('access_token is required')

    const endpoint = { baseUrl, chatwootAccountId, accessToken }

    // Confirms reachability + that the token can see the account.
    const profile = await verifyCredentials(endpoint)
    // Confirms inbox visibility and powers the picker UI.
    const inboxes = await listInboxes(endpoint)

    return NextResponse.json({
      ok: true,
      profile: {
        name: profile.name ?? null,
        email: profile.email ?? null,
      },
      inboxes,
    })
  } catch (err) {
    // ChatwootApiError messages are user-renderable by design (they
    // name the instance, status and remediation) — pass them through
    // instead of collapsing into the generic 500.
    if (err instanceof ChatwootApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    // Auth errors are handled by toErrorResponse.
    return toErrorResponse(err)
  }
}

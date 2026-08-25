import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for POST /api/chatwoot/whatsapp/disconnect: session logout is
// best-effort, idempotent when nothing is bound, and never blocks the UI.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getActiveChatwootConnection: vi.fn(),
  disconnectInboxProvider: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(
    () => Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}))

vi.mock('@/lib/chatwoot/send', () => ({
  getActiveChatwootConnection: mocks.getActiveChatwootConnection,
}))

vi.mock('@/lib/chatwoot/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chatwoot/api')>()
  return {
    ...actual,
    disconnectInboxProvider: mocks.disconnectInboxProvider,
  }
})

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const CONNECTION = {
  id: 'cw-conn-1',
  baseUrl: 'https://chatwoot.example.com',
  chatwootAccountId: 4,
  accessToken: 'token-1',
  inboxId: 42,
  inboxPhone: '+5511999999999',
  status: 'connected',
}

beforeEach(() => {
  __resetRateLimitForTests()
  vi.clearAllMocks()
  mocks.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-1',
    userId: 'user-1',
  })
})

describe('/api/chatwoot/whatsapp/disconnect', () => {
  it('logs the bound inbox out and reports success', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(CONNECTION)
    mocks.disconnectInboxProvider.mockResolvedValueOnce(undefined)

    const res = await POST()
    expect(res.status).toBe(200)
    expect(mocks.disconnectInboxProvider).toHaveBeenCalledWith(CONNECTION, 42)
  })

  it('is a no-op success without a gateway or bound inbox', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(null)
    const res = await POST()
    expect((await res.json()).success).toBe(true)
    expect(mocks.disconnectInboxProvider).not.toHaveBeenCalled()
  })
})

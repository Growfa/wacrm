import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for GET /api/chatwoot/whatsapp/status: the pairing states surfaced
// to the QR wizard (none / pending+QR / open) and error passthrough.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getActiveChatwootConnection: vi.fn(),
  getInboxProviderState: vi.fn(),
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
    getInboxProviderState: mocks.getInboxProviderState,
  }
})

import { GET } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { ChatwootApiError } from '@/lib/chatwoot/api'

const CONNECTION = {
  id: 'cw-conn-1',
  baseUrl: 'https://chatwoot.example.com',
  chatwootAccountId: 4,
  accessToken: 'token-1',
  inboxId: 42 as number | null,
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

describe('/api/chatwoot/whatsapp/status', () => {
  it('reports none when no gateway connection exists', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(null)
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({ pairing: 'none' })
    expect(mocks.getInboxProviderState).not.toHaveBeenCalled()
  })

  it('reports none when no inbox is bound yet', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: null,
      inboxPhone: null,
    })
    const res = await GET()
    expect((await res.json()).pairing).toBe('none')
  })

  it('relays a pending pairing with its QR data URL and error', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(CONNECTION)
    mocks.getInboxProviderState.mockResolvedValueOnce({
      connection: 'close',
      qrDataUrl: 'data:image/png;base64,AAAA',
      error: null,
    })

    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({
      pairing: 'pending',
      inbox_id: 42,
      phone_number: '+5511999999999',
      connection_state: 'close',
      qr_data_url: 'data:image/png;base64,AAAA',
      error: null,
    })
    expect(mocks.getInboxProviderState).toHaveBeenCalledWith(CONNECTION, 42)
  })

  it('flips to open once the session connects', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(CONNECTION)
    mocks.getInboxProviderState.mockResolvedValueOnce({
      connection: 'open',
    })

    const res = await GET()
    const body = await res.json()
    expect(body.pairing).toBe('open')
    expect(body.qr_data_url).toBeNull()
  })

  it('passes Chatwoot errors through with their status', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(CONNECTION)
    mocks.getInboxProviderState.mockRejectedValueOnce(
      new ChatwootApiError('inbox gone', 404)
    )

    const res = await GET()
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('inbox gone')
  })
})

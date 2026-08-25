import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for POST /api/chatwoot/whatsapp/connect: phone validation, gateway
// prerequisite, inbox creation + binding, same-number re-pair (QR refresh
// skips creation) and Chatwoot error passthrough.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getActiveChatwootConnection: vi.fn(),
  createBaileysInbox: vi.fn(),
  setupInboxProvider: vi.fn(),
  listInboxes: vi.fn(),
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
    createBaileysInbox: mocks.createBaileysInbox,
    setupInboxProvider: mocks.setupInboxProvider,
    listInboxes: mocks.listInboxes,
    getInboxProviderState: mocks.getInboxProviderState,
  }
})

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { ChatwootApiError } from '@/lib/chatwoot/api'

const CONNECTION = {
  id: 'cw-conn-1',
  baseUrl: 'https://chatwoot.example.com',
  chatwootAccountId: 4,
  accessToken: 'token-1',
  inboxId: null as number | null,
  inboxPhone: null as string | null,
  status: 'connected',
}

const updates: Array<Record<string, unknown>> = []

function makeSupabaseMock() {
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = vi.fn(chain)
  b.eq = vi.fn(chain)
  b.update = vi.fn((payload: Record<string, unknown>) => {
    updates.push(payload)
    return b
  })
  b.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: null, error: null })
  return { from: vi.fn(() => b) }
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/chatwoot/whatsapp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  updates.length = 0
  vi.clearAllMocks()
  mocks.listInboxes.mockResolvedValue([])
  // Stale-binding probe: by default the bound inbox still exists.
  mocks.getInboxProviderState.mockResolvedValue({})
  mocks.requireRole.mockResolvedValue({
    supabase: makeSupabaseMock(),
    accountId: 'acct-1',
    userId: 'user-1',
  })
})

describe('/api/chatwoot/whatsapp/connect', () => {
  it('rejects an invalid phone number', async () => {
    const res = await POST(request({ phone_number: 'abc' }))
    expect(res.status).toBe(400)
    expect(mocks.createBaileysInbox).not.toHaveBeenCalled()
  })

  it('requires a configured gateway first', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce(null)
    const res = await POST(request({ phone_number: '+5511999999999' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/gateway/i)
  })

  it('creates the inbox, binds it and starts pairing', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: null,
      inboxPhone: null,
    })
    mocks.createBaileysInbox.mockResolvedValueOnce({
      id: 42,
      name: 'WhatsApp +5511999999999',
    })

    const res = await POST(request({ phone_number: '+55 11 99999-9999' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, inbox_id: 42 })

    // Normalized E.164 reached the API client.
    expect(mocks.createBaileysInbox).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: CONNECTION.baseUrl }),
      { phoneNumber: '+5511999999999', name: undefined }
    )
    // Binding update hit the connection row.
    expect(updates[0]).toMatchObject({
      inbox_id: 42,
      inbox_phone: '+5511999999999',
    })
    // Pairing session kicked off for the new inbox.
    expect(mocks.setupInboxProvider).toHaveBeenCalledTimes(1)
  })

  it('forwards the typed inbox_name to creation', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: null,
      inboxPhone: null,
    })
    mocks.createBaileysInbox.mockResolvedValueOnce({
      id: 43,
      name: 'Atendimento',
    })

    const res = await POST(
      request({ phone_number: '+5511999999999', inbox_name: 'Atendimento' })
    )
    expect(res.status).toBe(200)
    expect(mocks.createBaileysInbox).toHaveBeenCalledWith(
      expect.anything(),
      { phoneNumber: '+5511999999999', name: 'Atendimento' }
    )
    expect(updates[0].inbox_name).toBe('Atendimento')
  })

  it('skips creation when the same number is already bound (QR refresh)', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: 12,
      inboxPhone: '+5511999999999',
    })

    const res = await POST(request({ phone_number: '+55 11 99999-9999' }))
    expect(res.status).toBe(200)
    // The stale-binding probe ran against the bound inbox.
    expect(mocks.getInboxProviderState).toHaveBeenCalledWith(
      expect.anything(),
      12
    )
    expect(mocks.createBaileysInbox).not.toHaveBeenCalled()
    expect(updates.length).toBe(0)
    expect(mocks.setupInboxProvider).toHaveBeenCalledWith(
      expect.anything(),
      12
    )
  })

  it('recreates the inbox when the bound one was deleted on the instance', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: 36,
      inboxPhone: '+5588993752128',
    })
    // Ghost binding: Chatwoot answers 404 for the bound inbox.
    mocks.getInboxProviderState.mockRejectedValueOnce(
      new ChatwootApiError('Inbox not found', 404)
    )
    mocks.createBaileysInbox.mockResolvedValueOnce({ id: 50, name: 'Novo' })

    const res = await POST(request({ phone_number: '+5588993752128' }))
    expect(res.status).toBe(200)

    // Same number, but the ghost binding fell through to creation.
    expect(mocks.createBaileysInbox).toHaveBeenCalledWith(
      expect.anything(),
      { phoneNumber: '+5588993752128', name: undefined }
    )
    expect(updates[0]).toMatchObject({
      inbox_id: 50,
      inbox_phone: '+5588993752128',
    })
    expect(mocks.setupInboxProvider).toHaveBeenCalledWith(
      expect.anything(),
      50
    )
  })

  it('propagates probe failures other than 404 (inbox exists but API is unhappy)', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: 12,
      inboxPhone: '+5511999999999',
    })
    mocks.getInboxProviderState.mockRejectedValueOnce(
      new ChatwootApiError('upstream exploded', 502)
    )

    const res = await POST(request({ phone_number: '+5511999999999' }))
    expect(res.status).toBe(502)
    expect(res.ok ? null : ((await res.json()) as { error: string }).error).toContain(
      'upstream'
    )
    expect(mocks.createBaileysInbox).not.toHaveBeenCalled()
  })

  it('passes Chatwoot errors through verbatim (duplicate number)', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: null,
      inboxPhone: null,
    })
    mocks.createBaileysInbox.mockRejectedValueOnce(
      new ChatwootApiError('Phone number has already been taken', 422)
    )

    const res = await POST(request({ phone_number: '+15551234567' }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain('already been taken')
  })

  it('refuses with 409 when another inbox already claims the number', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: null,
      inboxPhone: null,
    })
    mocks.listInboxes.mockResolvedValueOnce([
      { id: 9, name: 'Teste', phone_number: '5511999999999' },
    ])

    const res = await POST(request({ phone_number: '+55 11 99999-9999' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('Teste')
    expect(body.error).toContain('#9')
    expect(mocks.createBaileysInbox).not.toHaveBeenCalled()
    expect(mocks.setupInboxProvider).not.toHaveBeenCalled()
  })

  it('allows re-pairing a number this account already bound, skipping the clash check', async () => {
    mocks.getActiveChatwootConnection.mockResolvedValueOnce({
      ...CONNECTION,
      inboxId: 12,
      inboxPhone: '+5511999999999',
    })
    // Even if the instance list still shows the inbox, our binding wins.
    mocks.listInboxes.mockResolvedValueOnce([
      { id: 12, name: 'WhatsApp +5511999999999', phone_number: '+5511999999999' },
    ])

    const res = await POST(request({ phone_number: '+5511999999999' }))
    expect(res.status).toBe(200)
    expect(mocks.setupInboxProvider).toHaveBeenCalledWith(
      expect.anything(),
      12
    )
  })
})

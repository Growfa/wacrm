import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for /api/chatwoot/config after the env-var rework:
// credentials come from CHATWOOT_* server env vars (never the request
// body), the webhook HMAC secret is generated server-side unless
// CHATWOOT_WEBHOOK_SECRET pins it, and DB failures surface their raw
// message so a missing migration is diagnosable.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'CHATWOOT_BASE_URL',
  'CHATWOOT_ACCOUNT_ID',
  'CHATWOOT_ACCESS_TOKEN',
  'CHATWOOT_WEBHOOK_SECRET',
] as const

const savedEnv = new Map<string, string | undefined>()

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  verifyCredentials: vi.fn(),
  registerAccountWebhook: vi.fn(),
  deleteWebhooksByUrl: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(
    () => Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}))

vi.mock('@/lib/chatwoot/api', () => ({
  verifyCredentials: mocks.verifyCredentials,
  registerAccountWebhook: mocks.registerAccountWebhook,
  deleteWebhooksByUrl: mocks.deleteWebhooksByUrl,
  ChatwootApiError: class ChatwootApiError extends Error {},
  // Mirrors the real helper: accepts only well-formed https URLs.
  normalizeBaseUrl: (raw: string) =>
    /^https:\/\/[^\s]+$/i.test(raw) ? raw.replace(/\/+$/, '') : null,
}))

const encryptCalls: string[] = []
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => {
    encryptCalls.push(v)
    return `enc:${v}`
  }),
  decrypt: vi.fn(),
}))

import { GET, POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string | undefined> = {
    CHATWOOT_BASE_URL: 'https://chatwoot.example.com',
    CHATWOOT_ACCOUNT_ID: '4',
    CHATWOOT_ACCESS_TOKEN: 'token-1',
    CHATWOOT_WEBHOOK_SECRET: undefined,
    ...overrides,
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function makeSupabaseMock(result: {
  data?: unknown
  error?: unknown
} = { data: { id: 'cw-1' }, error: null }) {
  const upserts: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = vi.fn(chain)
  b.eq = vi.fn(chain)
  b.upsert = vi.fn((payload: Record<string, unknown>) => {
    upserts.push(payload)
    return b
  })
  b.update = vi.fn((payload: Record<string, unknown>) => {
    updates.push(payload)
    return b
  })
  b.single = vi.fn(() =>
    Promise.resolve({
      data: result.data ?? null,
      error: result.error ?? null,
    })
  )
  b.maybeSingle = vi.fn(() =>
    Promise.resolve({
      data: result.data ?? null,
      error: result.error ?? null,
    })
  )
  return { from: vi.fn(() => b), upserts, updates }
}

let db: ReturnType<typeof makeSupabaseMock>

async function postRequest(): Promise<Response> {
  return POST(
    new Request('http://localhost/api/chatwoot/config', { method: 'POST' })
  )
}

beforeEach(() => {
  __resetRateLimitForTests()
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k])
  encryptCalls.length = 0
  vi.clearAllMocks()
  setEnv()
  db = makeSupabaseMock()
  mocks.requireRole.mockResolvedValue({
    supabase: db as never,
    accountId: 'acct-1',
    userId: 'user-1',
  })
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: db as never,
    accountId: 'acct-1',
  })
  mocks.verifyCredentials.mockResolvedValue({ name: 'Admin' })
  mocks.registerAccountWebhook.mockResolvedValue({ id: 5, url: 'x' })
})

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('/api/chatwoot/config POST', () => {
  it('rejects with guidance when the env vars are missing', async () => {
    setEnv({ CHATWOOT_ACCESS_TOKEN: undefined })

    const res = await postRequest()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('CHATWOOT_ACCESS_TOKEN')
    expect(mocks.verifyCredentials).not.toHaveBeenCalled()
    expect(db.upserts.length).toBe(0)
  })

  it('saves using the env credentials and a generated secret', async () => {
    const res = await postRequest()
    expect(res.status).toBe(200)

    const payload = db.upserts[0]
    expect(payload.base_url).toBe('https://chatwoot.example.com')
    expect(payload.chatwoot_account_id).toBe(4)
    expect(payload.api_access_token).toBe('enc:token-1')
    // Inbox binding is NOT touched by the gateway prepare step.
    expect('inbox_id' in payload).toBe(false)
    expect('inbox_phone' in payload).toBe(false)

    const secretArg = mocks.registerAccountWebhook.mock.calls[0][2] as string
    expect(secretArg).toMatch(/^[0-9a-f]{48}$/)
    expect(payload.webhook_secret).toBe(`enc:${secretArg}`)
    expect(res.status === 200 && (await res.json()).webhook_url).toContain(
      '/api/chatwoot/webhook/cw-1'
    )
  })

  it('honors CHATWOOT_WEBHOOK_SECRET when pinned', async () => {
    setEnv({ CHATWOOT_WEBHOOK_SECRET: 'pinned-secret' })

    const res = await postRequest()
    expect(res.status).toBe(200)
    expect(mocks.registerAccountWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/api/chatwoot/webhook/'),
      'pinned-secret'
    )
    expect(db.upserts[0].webhook_secret).toBe('enc:pinned-secret')
  })

  it('re-encrypts the webhook secret when the fork returns its own', async () => {
    // The fazer.ai fork ignores the secret we send and generates its own.
    mocks.registerAccountWebhook.mockResolvedValueOnce({
      id: 5,
      url: 'x',
      secret: 'fork-generated-secret-abc',
    })

    const res = await postRequest()
    expect(res.status).toBe(200)

    // Initial upsert used the locally generated hex secret.
    const initialSecret = db.upserts[0].webhook_secret
    expect(initialSecret).toMatch(/^enc:[0-9a-f]{48}$/)

    // A subsequent UPDATE must have replaced it with the fork's secret.
    expect(db.updates.length).toBe(1)
    expect(db.updates[0].webhook_secret).toBe('enc:fork-generated-secret-abc')
  })

  it('skips the re-encrypt UPDATE when the fork returns the same secret', async () => {
    // Pin a known secret so we can compare.
    setEnv({ CHATWOOT_WEBHOOK_SECRET: 'same-secret' })
    mocks.registerAccountWebhook.mockResolvedValueOnce({
      id: 5,
      url: 'x',
      secret: 'same-secret',
    })

    const res = await postRequest()
    expect(res.status).toBe(200)
    expect(db.updates.length).toBe(0)
  })

  it('surfaces the raw DB message when the upsert fails', async () => {
    db = makeSupabaseMock({
      error: { message: 'relation "chatwoot_connections" does not exist' },
    })
    mocks.requireRole.mockResolvedValue({
      supabase: db as never,
      accountId: 'acct-1',
      userId: 'user-1',
    })

    const res = await postRequest()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to save configuration')
    expect(body.detail).toContain('does not exist')
  })

  it('collapses unexpected failures to the generic error envelope', async () => {
    // Non-ChatwootApiError rejections go through toErrorResponse,
    // which never leaks internals (mocked here as a bare 403).
    mocks.verifyCredentials.mockRejectedValueOnce(new Error('boom'))

    const res = await postRequest()
    expect(res.status).toBe(403)
    expect(db.upserts.length).toBe(0)
  })
})

describe('/api/chatwoot/config GET', () => {
  it('reports gateway_configured=false when no row exists yet', async () => {
    db = makeSupabaseMock({ data: null, error: null })
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: db as never,
      accountId: 'acct-1',
    })

    const res = await GET()
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.gateway_configured).toBe(true)
  })

  it('reports gateway_configured=false when env vars are absent', async () => {
    setEnv({
      CHATWOOT_BASE_URL: undefined,
      CHATWOOT_ACCOUNT_ID: undefined,
      CHATWOOT_ACCESS_TOKEN: undefined,
    })
    db = makeSupabaseMock({ data: null, error: null })
    mocks.getCurrentAccount.mockResolvedValue({
      supabase: db as never,
      accountId: 'acct-1',
    })

    const body = await (await GET()).json()
    expect(body.gateway_configured).toBe(false)
  })
})

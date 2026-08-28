import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for POST /api/chatwoot/webhook/[connectionId]: JSON validation,
// unknown-connection and signature gates, inbox-ownership gate, and the
// happy-path persistence of an inbound message.
// ---------------------------------------------------------------------------

const SECRET = 'whsec-test'

// Mutable state shared with the supabase mock (the route caches its admin
// client on first use, so tests mutate this instead of swapping clients).
const state = {
  connection: null as Record<string, unknown> | null,
  messageInserts: [] as Array<Record<string, unknown>>,
  conversationUpdates: [] as Array<Record<string, unknown>>,
}

const CONNECTION = {
  id: 'cw-conn-1',
  account_id: 'acct-1',
  created_by: 'user-admin',
  inbox_id: 12,
  webhook_secret: 'enc-secret',
}

function makeAdminMock() {
  function builder(table: string) {
    let didInsert = false
    const selectResult = () => {
      if (table === 'chatwoot_connections') return { data: state.connection, error: null }
      if (table === 'conversations')
        return { data: [{ id: 'conv-1', unread_count: 0, status: 'open' }], error: null }
      return { data: null, error: null }
    }
    const insertResult = () => {
      if (table === 'messages') return { data: { id: 'msg-1' }, error: null }
      if (table === 'contacts') return { data: { id: 'contact-1' }, error: null }
      if (table === 'conversations')
        return { data: { id: 'conv-1', unread_count: 0 }, error: null }
      return { data: null, error: null }
    }
    const terminal = () => Promise.resolve(didInsert ? insertResult() : selectResult())
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'neq', 'in', 'like', 'ilike', 'gte', 'lte', 'order', 'limit', 'update']) {
      b[m] = vi.fn((p?: unknown) => {
        if (m === 'update' && table === 'conversations')
          state.conversationUpdates.push(p as Record<string, unknown>)
        return b
      })
    }
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'messages') state.messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }
  return { from: vi.fn((table: string) => builder(table)) }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeAdminMock()),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  const afterCallbacks: Array<() => Promise<void> | void> = []
  return {
    ...actual,
    after: vi.fn((cb: () => Promise<void> | void) => {
      afterCallbacks.push(cb)
    }),
    __afterCallbacks: afterCallbacks,
  }
})

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => SECRET),
}))

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}))

import { POST } from './route'
import { decrypt } from '@/lib/whatsapp/encryption'
import * as server from 'next/server'

const afterCallbacks = (
  server as unknown as { __afterCallbacks: Array<() => Promise<void>> }
).__afterCallbacks

function signedRequest(
  body: string,
  connectionId = CONNECTION.id,
  sign = true
): Request {
  const ts = '1756000000'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-chatwoot-timestamp': ts,
  }
  if (sign) {
    headers['x-chatwoot-signature'] =
      'sha256=' +
      crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
  }
  return new Request(
    `http://localhost/api/chatwoot/webhook/${connectionId}`,
    { method: 'POST', headers, body }
  )
}

function payloadBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'message_created',
    id: 501,
    content: 'oi',
    message_type: 'incoming',
    created_at: 1_756_000_000,
    sender: { name: 'Ana', phone_number: '+5511912345678' },
    inbox: { id: 12 },
    conversation: { display_id: 88, inbox_id: 12 },
    ...overrides,
  })
}

describe('POST /api/chatwoot/webhook/[connectionId]', () => {
  beforeEach(() => {
    state.connection = CONNECTION
    state.messageInserts.length = 0
    state.conversationUpdates.length = 0
    afterCallbacks.length = 0
    vi.mocked(decrypt).mockClear?.()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 on malformed JSON before any auth work', async () => {
    const res = await POST(signedRequest('{not json'), {
      params: Promise.resolve({ connectionId: CONNECTION.id }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown or disconnected connection', async () => {
    state.connection = null
    const res = await POST(signedRequest(payloadBody()), {
      params: Promise.resolve({ connectionId: 'missing' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects deliveries whose signature does not verify', async () => {
    const res = await POST(signedRequest(payloadBody(), CONNECTION.id, false), {
      params: Promise.resolve({ connectionId: CONNECTION.id }),
    })
    expect(res.status).toBe(401)
  })

  it('persists an inbound message and bumps the conversation', async () => {
    const res = await POST(signedRequest(payloadBody()), {
      params: Promise.resolve({ connectionId: CONNECTION.id }),
    })
    expect(res.status).toBe(200)

    // The pipeline ran inside after().
    expect(afterCallbacks).toHaveLength(1)
    await afterCallbacks[0]()

    expect(state.messageInserts).toHaveLength(1)
    expect(state.messageInserts[0]).toMatchObject({
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'oi',
      message_id: '501',
      channel: 'chatwoot',
    })
    // Two updates hit the conversation: the display-id link and the
    // preview/unread bump.
    expect(state.conversationUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatwoot_conversation_id: 88 }),
      ])
    )
    const preview = state.conversationUpdates.find((u) => 'last_message_text' in (u as Record<string, unknown>))
    expect(preview).toMatchObject({
      last_message_text: 'oi',
      unread_count: 1,
    })
  })

  it('drops events whose inbox belongs to another connection', async () => {
    const res = await POST(
      signedRequest(payloadBody({ inbox: { id: 99 }, conversation: { display_id: 5, inbox_id: 99 } })),
      { params: Promise.resolve({ connectionId: CONNECTION.id }) }
    )
    expect(res.status).toBe(200)
    await afterCallbacks[0]()
    expect(state.messageInserts).toHaveLength(0)
  })

  it('persists an outgoing agent message as sender_type=agent without bumping unread', async () => {
    const res = await POST(
      signedRequest(
        payloadBody({
          message_type: 'outgoing',
          content: 'resposta do celular',
          sender: { name: 'Minha Loja', phone_number: '+5588993752128' },
          conversation: {
            display_id: 88,
            inbox_id: 12,
            meta: { sender: { phone_number: '+5511912345678', name: 'Ana' } },
          },
        })
      ),
      { params: Promise.resolve({ connectionId: CONNECTION.id }) }
    )
    expect(res.status).toBe(200)
    await afterCallbacks[0]()

    expect(state.messageInserts).toHaveLength(1)
    expect(state.messageInserts[0]).toMatchObject({
      sender_type: 'agent',
      content_text: 'resposta do celular',
      message_id: '501',
      channel: 'chatwoot',
    })
    // The preview updates but unread stays flat (agent activity).
    const preview = state.conversationUpdates.find((u) => 'last_message_text' in (u as Record<string, unknown>))
    expect(preview).toMatchObject({
      last_message_text: 'resposta do celular',
      unread_count: 0,
    })
  })
})

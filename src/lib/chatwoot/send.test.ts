import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the Chatwoot outbound adapter (migration 037): feature gates,
// display-id linking requirement, transport call shape and the shared
// persistence contract (channel: 'chatwoot').
// ---------------------------------------------------------------------------

const connectionRow = {
  id: 'cw-conn-1',
  base_url: 'https://chatwoot.example.com',
  chatwoot_account_id: 4,
  api_access_token: 'enc-token',
  inbox_id: 12,
  status: 'connected',
}

let storedConnection: typeof connectionRow | null = connectionRow

// Chainable Supabase mock — same style as the send route tests. Only the
// tables the adapter + shared persistence touch are modelled.
function makeSupabaseMock() {
  const messageInserts: Array<Record<string, unknown>> = []
  const conversationUpdates: Array<Record<string, unknown>> = []

  function builder(table: string) {
    let didInsert = false

    const selectResult = () => {
      switch (table) {
        case 'chatwoot_connections':
          return { data: storedConnection, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      if (table === 'messages') return { data: { id: 'msg-internal-1' }, error: null }
      return { data: null, error: null }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = vi.fn(chain)
    b.eq = vi.fn(chain)
    b.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'conversations') conversationUpdates.push(payload)
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'messages') messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    db: { from: vi.fn((table: string) => builder(table)) },
    messageInserts,
    conversationUpdates,
  }
}

let mocks = makeSupabaseMock()

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plain-access-token'),
  encrypt: vi.fn(() => 'enc'),
  isLegacyFormat: vi.fn(() => false),
}))

const { createConversationMessage } = vi.hoisted(() => ({
  createConversationMessage: vi.fn(async () => ({ id: 777 })),
}))
const { fetchAttachmentBytes } = vi.hoisted(() => ({
  fetchAttachmentBytes: vi.fn(),
}))
vi.mock('@/lib/chatwoot/api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/chatwoot/api')>()
  return {
    ...actual,
    createConversationMessage,
    fetchAttachmentBytes,
  }
})

import { decrypt } from '@/lib/whatsapp/encryption'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import {
  getActiveChatwootConnection,
  sendMessageViaChatwoot,
} from './send'

const CONVERSATION = { id: 'conv-1', chatwoot_conversation_id: 88 }
const CONTACT = { id: 'contact-1', phone: '+15551234567' }
// The preloaded connection the dispatcher (send-message.ts) passes in.
const CONN = {
  id: 'cw-conn-1',
  baseUrl: 'https://chatwoot.example.com',
  chatwootAccountId: 4,
  accessToken: 'plain-access-token',
  inboxId: 12,
  inboxPhone: '+15551234567',
  status: 'connected' as const,
}

describe('getActiveChatwootConnection', () => {
  it('returns a decrypted connection row', async () => {
    const { db } = makeSupabaseMock()
    const conn = await getActiveChatwootConnection(db as never, 'acct-1')
    expect(conn).not.toBeNull()
    expect(conn!.baseUrl).toBe('https://chatwoot.example.com')
    expect(conn!.chatwootAccountId).toBe(4)
    // The stored ciphertext was run through decrypt().
    expect(decrypt).toHaveBeenCalledWith('enc-token')
  })

  it('returns null when no connected row exists', async () => {
    storedConnection = null
    try {
      const { db } = makeSupabaseMock()
      expect(await getActiveChatwootConnection(db as never, 'acct-1')).toBeNull()
    } finally {
      storedConnection = connectionRow
    }
  })
})

describe('sendMessageViaChatwoot', () => {
  beforeEach(() => {
    mocks = makeSupabaseMock()
    createConversationMessage.mockClear()
    fetchAttachmentBytes.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('refuses template sends with unsupported_channel before any API call', async () => {
    await expect(
      sendMessageViaChatwoot(
        mocks.db as never, 'acct-1', CONVERSATION, CONTACT,
        { messageType: 'template', templateName: 'hello' } as never,
        CONN
      )
    ).rejects.toMatchObject({ code: 'unsupported_channel', status: 400 })
    expect(createConversationMessage).not.toHaveBeenCalled()
  })

  it('requires a linked Chatwoot conversation (chatwoot_not_linked)', async () => {
    await expect(
      sendMessageViaChatwoot(
        mocks.db as never, 'acct-1',
        { id: 'conv-2', chatwoot_conversation_id: null }, CONTACT,
        { messageType: 'text', contentText: 'hi' },
        CONN
      )
    ).rejects.toMatchObject({ code: 'chatwoot_not_linked', status: 400 })
    expect(createConversationMessage).not.toHaveBeenCalled()
  })

  it('sends text through the Chatwoot API and persists with channel=chatwoot', async () => {
    const result = await sendMessageViaChatwoot(
      mocks.db as never, 'acct-1', CONVERSATION, CONTACT,
      { messageType: 'text', contentText: 'olá!' },
      CONN
    )

    expect(result.messageId).toBe('msg-internal-1')
    expect(result.whatsappMessageId).toBe('777')

    expect(createConversationMessage).toHaveBeenCalledTimes(1)
    expect(createConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://chatwoot.example.com',
        chatwootAccountId: 4,
        accessToken: 'plain-access-token',
        conversationId: 88,
        content: 'olá!',
      })
    )

    expect(mocks.messageInserts).toHaveLength(1)
    expect(mocks.messageInserts[0]).toMatchObject({
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'olá!',
      message_id: '777',
      channel: 'chatwoot',
    })
    expect(mocks.conversationUpdates[0]).toMatchObject({
      last_message_text: 'olá!',
    })
  })

  it('downloads outbound media and uploads it as an attachment', async () => {
    fetchAttachmentBytes.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/pdf',
    })
    await sendMessageViaChatwoot(
      mocks.db as never, 'acct-1', CONVERSATION, CONTACT,
      { messageType: 'document', mediaUrl: 'https://bucket/invoice.pdf', filename: 'invoice.pdf' },
      CONN
    )
    expect(fetchAttachmentBytes).toHaveBeenCalledWith('https://bucket/invoice.pdf')
    const arg = (createConversationMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(arg.attachment).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf' })
    expect(mocks.messageInserts[0]).toMatchObject({
      content_type: 'document',
      media_url: 'https://bucket/invoice.pdf',
    })
  })

  it('wraps Chatwoot API failures into a 502 chatwoot_error', async () => {
    createConversationMessage.mockRejectedValueOnce(new Error('boom'))
    await expect(
      sendMessageViaChatwoot(
        mocks.db as never, 'acct-1', CONVERSATION, CONTACT,
        { messageType: 'text', contentText: 'hi' },
        CONN
      )
    ).rejects.toMatchObject({
      code: 'chatwoot_error',
      status: 502,
      name: 'SendMessageError',
    })
  })

  it('rejects invalid E164 phones exactly like the Meta path', async () => {
    await expect(
      sendMessageViaChatwoot(
        mocks.db as never, 'acct-1', CONVERSATION,
        { id: 'contact-1', phone: '12345' },
        { messageType: 'text', contentText: 'hi' },
        CONN
      )
    ).rejects.toBeInstanceOf(SendMessageError)
    expect(createConversationMessage).not.toHaveBeenCalled()
  })
})

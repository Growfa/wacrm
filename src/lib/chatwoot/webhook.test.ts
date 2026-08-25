import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  verifyChatwootSignature,
  normalizeIncomingMessage,
  normalizeStatusUpdate,
  extractSenderPhone,
} from './webhook'

const SECRET = 'whsec-test-123'

function sign(body: string, timestamp: string, secret = SECRET): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  )
}

describe('verifyChatwootSignature', () => {
  const body = JSON.stringify({ event: 'message_created', id: 1 })

  it('accepts a correctly signed delivery', () => {
    const ts = '1756000000'
    expect(
      verifyChatwootSignature(body, ts, sign(body, ts), SECRET)
    ).toBe(true)
  })

  it('rejects a signature made with a different secret', () => {
    const ts = '1756000000'
    const forged = sign(body, ts, 'wrong-secret')
    expect(verifyChatwootSignature(body, ts, forged, SECRET)).toBe(false)
  })

  it('rejects when the body was tampered with', () => {
    const ts = '1756000000'
    const sig = sign(body, ts)
    expect(
      verifyChatwootSignature(body + ' ', ts, sig, SECRET)
    ).toBe(false)
  })

  it('fails closed on missing headers or empty secret', () => {
    const ts = '1756000000'
    const sig = sign(body, ts)
    expect(verifyChatwootSignature(body, null, sig, SECRET)).toBe(false)
    expect(verifyChatwootSignature(body, ts, null, SECRET)).toBe(false)
    expect(verifyChatwootSignature(body, ts, sig, '')).toBe(false)
  })

  it('rejects a signature without the sha256= prefix', () => {
    const ts = '1756000000'
    const bare = sign(body, ts).replace('sha256=', '')
    expect(verifyChatwootSignature(body, ts, bare, SECRET)).toBe(false)
  })
})

describe('normalizeIncomingMessage', () => {
  function messageCreated(overrides: Record<string, unknown> = {}) {
    return {
      event: 'message_created',
      id: 501,
      content: 'hello there',
      message_type: 'incoming',
      created_at: 1_756_000_000,
      sender: { id: 9, name: 'Ana', phone_number: '+55 11 91234-5678' },
      inbox: { id: 12 },
      conversation: { display_id: 88, inbox_id: 12 },
      ...overrides,
    } as Parameters<typeof normalizeIncomingMessage>[0]
  }

  it('normalizes a plain-text inbound message', () => {
    const normalized = normalizeIncomingMessage(messageCreated())
    expect(normalized).not.toBeNull()
    expect(normalized!.messageId).toBe(501)
    expect(normalized!.senderPhone).toBe('5511912345678')
    expect(normalized!.senderName).toBe('Ana')
    expect(normalized!.conversationDisplayId).toBe(88)
    expect(normalized!.inboxId).toBe(12)
    expect(normalized!.contentType).toBe('text')
    expect(normalized!.contentText).toBe('hello there')
    // Unix seconds → ISO.
    expect(normalized!.createdAtIso).toBe(
      new Date(1_756_000_000_000).toISOString()
    )
  })

  it('returns null for outgoing echoes of our own sends', () => {
    expect(
      normalizeIncomingMessage(messageCreated({ message_type: 'outgoing' }))
    ).toBeNull()
  })

  it('returns null for template notices (numeric outgoing variant too)', () => {
    expect(
      normalizeIncomingMessage(messageCreated({ message_type: 'template' }))
    ).toBeNull()
    expect(normalizeIncomingMessage(messageCreated({ message_type: 1 }))).toBeNull()
  })

  it('returns null when the sender phone cannot be resolved', () => {
    expect(
      normalizeIncomingMessage(messageCreated({ sender: { name: 'X' }, conversation: {} }))
    ).toBeNull()
  })

  it('maps attachments onto our content types and keeps captions', () => {
    const normalized = normalizeIncomingMessage(
      messageCreated({
        content: 'see attached',
        attachments: [
          {
            file_type: 'file',
            data_url:
              'https://cw.example/rails/active_storage/representations/proxy/invoice.pdf?sig=abc',
            extension: 'pdf',
          },
        ],
      })
    )
    expect(normalized!.contentType).toBe('document')
    expect(normalized!.attachmentUrl).toContain('invoice.pdf')
    expect(normalized!.attachmentFilename).toBe('invoice.pdf')
    expect(normalized!.contentText).toBe('see attached')
  })

  it('maps voice notes to audio', () => {
    const normalized = normalizeIncomingMessage(
      messageCreated({
        content: '',
        attachments: [{ file_type: 'voice_note', data_url: 'https://x.example/a.ogg' }],
      })
    )
    expect(normalized!.contentType).toBe('audio')
    expect(normalized!.contentText).toBeNull()
  })

  it('parses Chatwoot-style "UTC" timestamps', () => {
    const normalized = normalizeIncomingMessage(
      messageCreated({ created_at: '2026-08-24 12:00:00 UTC' })
    )
    expect(normalized!.createdAtIso).toBe(
      new Date('2026-08-24T12:00:00Z').toISOString()
    )
  })
})

describe('normalizeStatusUpdate', () => {
  it('maps a read receipt', () => {
    expect(normalizeStatusUpdate({ id: 501, status: 'read' })).toEqual({
      messageId: 501,
      status: 'read',
    })
  })

  it('ignores statuses outside our enum', () => {
    expect(normalizeStatusUpdate({ id: 501, status: 'archived' })).toBeNull()
    expect(normalizeStatusUpdate({ status: 'read' })).toBeNull()
  })
})

describe('extractSenderPhone', () => {
  it('falls back to conversation.meta.sender', () => {
    expect(
      extractSenderPhone({
        conversation: { meta: { sender: { phone_number: '+15550001111' } } },
      })
    ).toBe('15550001111')
  })

  it('returns null below the minimum digit threshold', () => {
    expect(extractSenderPhone({ sender: { phone_number: '+123' } })).toBeNull()
  })
})

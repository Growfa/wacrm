import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the Baileys inbox lifecycle helpers in api.ts: request shapes,
// provider_connection parsing (qr_data_url must be a data URL) and the
// fail-open contract of disconnect.
// ---------------------------------------------------------------------------

const ENDPOINT = {
  baseUrl: 'https://chatwoot.example.com',
  chatwootAccountId: 4,
  accessToken: 'token-1',
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

import {
  createBaileysInbox,
  deleteWebhooksByUrl,
  disconnectInboxProvider,
  getInboxProviderState,
  registerAccountWebhook,
  setupInboxProvider,
  ChatwootApiError,
} from './api'

describe('createBaileysInbox', () => {
  it('POSTs a whatsapp/baileys channel payload and parses the inbox', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 42, name: 'WhatsApp +5511999999999' })
    )

    const created = await createBaileysInbox(ENDPOINT, {
      phoneNumber: '+5511999999999',
    })

    expect(created).toEqual({ id: 42, name: 'WhatsApp +5511999999999' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://chatwoot.example.com/api/v1/accounts/4/inboxes'
    )
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).api_access_token).toBe(
      'token-1'
    )
    const body = JSON.parse(init.body as string)
    expect(body.name).toBe('WhatsApp +5511999999999')
    expect(body.channel).toMatchObject({
      type: 'whatsapp',
      phone_number: '+5511999999999',
      provider: 'baileys',
      provider_config: { mark_as_read: true, presence_subscribe: false },
    })
  })

  it('uses a custom name when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 7, name: 'Vendas' }))
    await createBaileysInbox(ENDPOINT, {
      phoneNumber: '+15551234567',
      name: ' Vendas ',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).name).toBe(
      'Vendas'
    )
  })

  it('surfaces error statuses as ChatwootApiError (duplicate number 422)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { error: 'Phone number has already been taken' })
    )
    await expect(
      createBaileysInbox(ENDPOINT, { phoneNumber: '+15551234567' })
    ).rejects.toMatchObject({
      name: 'ChatwootApiError',
      status: 422,
    })
  })
})

describe('setupInboxProvider', () => {
  it('POSTs to the member action and tolerates an empty 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await setupInboxProvider(ENDPOINT, 42)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://chatwoot.example.com/api/v1/accounts/4/inboxes/42/setup_channel_provider'
    )
    expect(init.method).toBe('POST')
  })

  it('throws ChatwootApiError on failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'down' }))
    await expect(setupInboxProvider(ENDPOINT, 42)).rejects.toBeInstanceOf(
      ChatwootApiError
    )
  })
})

describe('getInboxProviderState', () => {
  it('parses connection state, QR data URL and error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 42,
        provider_connection: {
          connection: 'close',
          qr_data_url: 'data:image/png;base64,AAAA',
          error: 'stale session',
        },
      })
    )

    const state = await getInboxProviderState(ENDPOINT, 42)
    expect(state).toEqual({
      connection: 'close',
      qrDataUrl: 'data:image/png;base64,AAAA',
      error: 'stale session',
    })
  })

  it('ignores a non-data-url qr field and missing blob', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 42,
        provider_connection: { connection: 'open', qr_data_url: 'junk' },
      })
    )
    expect(await getInboxProviderState(ENDPOINT, 42)).toEqual({
      connection: 'open',
    })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 42 }))
    expect(await getInboxProviderState(ENDPOINT, 42)).toEqual({})
  })
})

describe('disconnectInboxProvider', () => {
  it('POSTs the member action', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await disconnectInboxProvider(ENDPOINT, 42)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://chatwoot.example.com/api/v1/accounts/4/inboxes/42/disconnect_channel_provider'
    )
    expect(init.method).toBe('POST')
  })

  it('is fail-open: swallows HTTP errors and transport failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'no session' }))
    await expect(disconnectInboxProvider(ENDPOINT, 42)).resolves.toBeUndefined()

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(disconnectInboxProvider(ENDPOINT, 42)).resolves.toBeUndefined()
  })
})

describe('deleteWebhooksByUrl', () => {
  it('matches by URL path, sweeping hooks left under old hosts', async () => {
    // GET webhooks → two hooks share the CRM path but live under
    // different origins (dev tunnel vs production), plus one unrelated.
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, {
        payload: [
          { id: 19, url: 'https://old-tunnel.trycloudflare.com/api/chatwoot/webhook/abc' },
          { id: 20, url: 'https://crm.example.com/api/chatwoot/webhook/abc' },
          { id: 21, url: 'https://crm.example.com/api/v1/other' },
        ],
      })
    )

    await deleteWebhooksByUrl(
      ENDPOINT,
      'https://crm.example.com/api/chatwoot/webhook/abc'
    )

    const deletes = fetchMock.mock.calls.filter((c) => c[1]?.method === 'DELETE')
    expect(deletes).toHaveLength(2)
    expect(deletes.map((c) => c[0])).toEqual([
      'https://chatwoot.example.com/api/v1/accounts/4/webhooks/19',
      'https://chatwoot.example.com/api/v1/accounts/4/webhooks/20',
    ])
  })

  it('parses the nested { payload: { webhooks: [] } } envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        payload: {
          webhooks: [
            { id: 33, url: 'https://anywhere.test/api/chatwoot/webhook/xyz' },
          ],
        },
      })
    )

    await deleteWebhooksByUrl(
      ENDPOINT,
      'https://anywhere.test/api/chatwoot/webhook/xyz'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, delInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(delInit.method).toBe('DELETE')
  })

  it('deletes nothing when no hook shares the path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { payload: [{ id: 5, url: 'https://x.test/unrelated' }] })
    )
    await deleteWebhooksByUrl(ENDPOINT, 'https://x.test/api/chatwoot/webhook/q')
    expect(fetchMock).toHaveBeenCalledOnce() // only the GET
  })
})

describe('registerAccountWebhook', () => {
  it('reads id and secret from the fazer.ai { payload: { webhook } } envelope', async () => {
    // The fork wraps the created webhook under payload.webhook and
    // assigns its OWN secret (ignoring the one we sent).
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        payload: {
          webhook: {
            id: 28,
            url: 'https://crm.example.com/api/chatwoot/webhook/abc',
            secret: 'P8KMc8MKyiXkTpyCCX2LjJjA',
          },
        },
      })
    )

    const record = await registerAccountWebhook(
      ENDPOINT,
      'https://crm.example.com/api/chatwoot/webhook/abc',
      'a'.repeat(48)
    )

    expect(record).toEqual({
      id: 28,
      url: 'https://crm.example.com/api/chatwoot/webhook/abc',
      secret: 'P8KMc8MKyiXkTpyCCX2LjJjA',
    })
  })

  it('reads the webhook from a flat { webhook } response (upstream)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        webhook: { id: 7, url: 'https://x.test/api/chatwoot/webhook/z', secret: 'flat-secret' },
      })
    )
    const record = await registerAccountWebhook(
      ENDPOINT,
      'https://x.test/api/chatwoot/webhook/z',
      'secret'
    )
    expect(record).toEqual({
      id: 7,
      url: 'https://x.test/api/chatwoot/webhook/z',
      secret: 'flat-secret',
    })
  })
})

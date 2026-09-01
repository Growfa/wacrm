import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAttachmentBytes } from './api'

const deliverable = vi.fn(async (url: string) => {
  void url
  return true
})
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: (url: string) => deliverable(url),
}))

describe('fetchAttachmentBytes', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    deliverable.mockResolvedValue(true)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('follows a 302 redirect chain and returns the final bytes + content-type', async () => {
    const locDisk =
      'https://chatwoot.example.com/rails/active_storage/disk/abc.jpeg'
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: locDisk } }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      )

    const result = await fetchAttachmentBytes(
      'https://chatwoot.example.com/rails/active_storage/blobs/redirect/sig.jpeg',
    )

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4])
    expect(result.contentType).toBe('image/jpeg')
    // Every URL — initial + each redirect hop — is SSRF-revalidated.
    expect(deliverable).toHaveBeenCalledTimes(2)
  })

  it('rejects the destination when a redirect target is not deliverable (SSRF)', async () => {
    const evil = 'http://169.254.169.254/latest/meta-data'
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: evil } }),
      )
    deliverable.mockReset()
    deliverable.mockImplementation(async (u: string) => !u.includes('169.254'))

    await expect(
      fetchAttachmentBytes('https://public.example/file'),
    ).rejects.toThrow('Media URL is not reachable')
  })

  it('throws on a redirect without a Location header', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
    await expect(fetchAttachmentBytes('https://public.example/file')).rejects.toThrow(
      'Redirect without a Location header',
    )
  })

  it('throws after exhausting the redirect hop cap', async () => {
    global.fetch = vi
      .fn()
      .mockImplementation((u: string) =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: `${u}x` } }),
        ),
      )
    await expect(fetchAttachmentBytes('https://public.example/a')).rejects.toThrow(
      'Too many redirects downloading media',
    )
  })

  it('throws when the initial URL is not deliverable', async () => {
    deliverable.mockResolvedValue(false)
    await expect(fetchAttachmentBytes('http://localhost/x')).rejects.toThrow(
      'Media URL is not reachable',
    )
  })
})

// ============================================================
// Chatwoot Application API client — the transport half of the
// unofficial WhatsApp channel (migration 037).
//
// Every call targets a self-hosted Chatwoot instance (fazer.ai
// fork) using a user `access_token` passed in the
// `api_access_token` header. Endpoints used (all under
// /api/v1/accounts/{account_id}):
//
//   GET  /profile                          → validate credentials
//   GET  /inboxes                          → list bound inboxes
//   POST /conversations/{display_id}/messages → send text/media
//
// Outbound media is uploaded as multipart form-data with an
// `attachments[]` file part; text rides along as `content`.
// ============================================================

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

export class ChatwootApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ChatwootApiError';
    this.status = status;
  }
}

export interface ChatwootEndpoint {
  /** Chatwoot base URL, no trailing slash. */
  baseUrl: string;
  chatwootAccountId: number;
  accessToken: string;
}

/** Subset of GET /profile we care about. */
export interface ChatwootProfile {
  id?: number;
  name?: string;
  email?: string;
  accounts?: Array<{ id: number; name?: string; role?: string }>;
}

export interface ChatwootInbox {
  id: number;
  name: string;
  channel_type?: string;
  phone_number?: string | null;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Normalize a base URL: trim, strip trailing slashes/path, require http(s). */
export function normalizeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Root path only — anything else would break endpoint construction.
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

async function parseError(response: Response): Promise<ChatwootApiError> {
  let detail = '';
  try {
    const body = await response.json();
    detail =
      typeof body?.error === 'string'
        ? body.error
        : JSON.stringify(body).slice(0, 300);
  } catch {
    detail = response.statusText;
  }
  return new ChatwootApiError(
    `Chatwoot API ${response.status}: ${detail}`,
    response.status,
  );
}

/**
 * Validate credentials against GET /api/v1/profile and confirm the
 * token can actually see the configured account. Returns the profile
 * so the caller can display who is connected.
 */
export async function verifyCredentials(
  endpoint: ChatwootEndpoint,
): Promise<ChatwootProfile> {
  const url = joinUrl(endpoint.baseUrl, '/api/v1/profile');
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { api_access_token: endpoint.accessToken },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ChatwootApiError(
      `Could not reach Chatwoot at ${url}: ${err instanceof Error ? err.message : err}`,
      502,
    );
  }
  if (!response.ok) throw await parseError(response);

  const profile = (await response.json()) as ChatwootProfile;
  const accounts = profile.accounts ?? [];
  if (
    accounts.length > 0 &&
    !accounts.some((a) => a.id === endpoint.chatwootAccountId)
  ) {
    throw new ChatwootApiError(
      `This token cannot access Chatwoot account ${endpoint.chatwootAccountId}. ` +
        `Visible accounts: ${accounts.map((a) => a.id).join(', ') || 'none'}.`,
      403,
    );
  }
  return profile;
}

/**
 * List the account's inboxes, filtered to WhatsApp channels when any
 * exist (the fork exposes Channel::Whatsapp for both official and
 * Baileys/Z-API provider inboxes).
 */
export async function listInboxes(
  endpoint: ChatwootEndpoint,
): Promise<ChatwootInbox[]> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/inboxes`,
  );
  const response = await fetch(url, {
    headers: { api_access_token: endpoint.accessToken },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await parseError(response);

  const body = (await response.json()) as { payload?: Array<Record<string, unknown>> };
  const inboxes: ChatwootInbox[] = (body.payload ?? []).map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? `Inbox ${row.id}`),
    channel_type: row.channel_type ? String(row.channel_type) : undefined,
    phone_number:
      typeof row.phone_number === 'string' ? row.phone_number : null,
  }));
  return inboxes;
}

export interface CreateMessageResult {
  /** Chatwoot's numeric message id (persisted to messages.message_id). */
  id: number;
}

interface CreateMessageInput extends ChatwootEndpoint {
  /** Chatwoot conversation display_id. */
  conversationId: number;
  content?: string;
  /** Already-fetched bytes for the attachment (multipart upload). */
  attachment?: { bytes: Uint8Array; filename: string; contentType: string };
}

/**
 * POST an outgoing message into a Chatwoot conversation.
 *
 * Text-only calls use JSON; attachment calls switch to multipart
 * form-data (Chatwoot reads `attachments[]` file parts there and
 * stores them through its own storage service).
 *
 * `private` is never set — everything we post must reach WhatsApp.
 * `message_type` defaults to `outgoing` server-side but we send it
 * explicitly so behaviour doesn't drift across Chatwoot versions.
 */
export async function createConversationMessage(
  input: CreateMessageInput,
): Promise<CreateMessageResult> {
  const { baseUrl, chatwootAccountId, accessToken } = input;
  const url = joinUrl(
    baseUrl,
    `/api/v1/accounts/${chatwootAccountId}/conversations/${input.conversationId}/messages`,
  );

  let response: Response;
  if (input.attachment) {
    const form = new FormData();
    form.append('message_type', 'outgoing');
    if (input.content) form.append('content', input.content);
    // Blob carries the MIME type so Chatwoot stores the right
    // content type instead of sniffing it.
    form.append(
      'attachments[]',
      new Blob([new Uint8Array(input.attachment.bytes)], {
        type: input.attachment.contentType,
      }),
      input.attachment.filename,
    );
    response = await fetch(url, {
      method: 'POST',
      headers: { api_access_token: accessToken },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } else {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        api_access_token: accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message_type: 'outgoing',
        content: input.content ?? '',
      }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { id?: number };
  return { id: Number(body.id ?? 0) };
}

/**
 * Download attachment bytes from a URL (used for outbound media: the
 * URL is our own Supabase Storage public link).
 *
 * SSRF-guarded with the same resolver the webhook deliverer uses, and
 * capped at 16 MB to match the storage bucket limit.
 */
export async function fetchAttachmentBytes(
  rawUrl: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!(await isDeliverableUrl(rawUrl))) {
    throw new ChatwootApiError('Media URL is not reachable', 400);
  }
  const response = await fetch(rawUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new ChatwootApiError(
      `Failed to download media (${response.status})`,
      400,
    );
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ChatwootApiError('Media exceeds the 16 MB limit', 400);
  }
  return {
    bytes: new Uint8Array(buffer),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

// ------------------------------------------------------------
// Account webhook registration.
//
// wacrm registers ONE account webhook per connection pointing back at
// our /api/chatwoot/webhook route, subscribed to exactly the two
// events the pipeline consumes. Newer Chatwoot versions sign each
// delivery as sha256=HMAC(secret, "{timestamp}.{body}") — we pass our
// per-connection secret at creation time; older forks ignore it, and
// callers surface a manual-setup fallback when registration fails.
// ------------------------------------------------------------

export interface ChatwootWebhookRecord {
  id: number;
  url: string;
  /** The actual secret the Chatwoot instance uses for HMAC signing.
   *  Some forks (e.g. fazer.ai) ignore the secret we send at creation
   *  time and generate their own — we must store whatever they return
   *  so the webhook route can verify incoming signatures. */
  secret?: string;
}

/** Subscriptions the inbound pipeline actually consumes. */
export const CHATWOOT_WEBHOOK_SUBSCRIPTIONS = [
  'message_created',
  'message_updated',
] as const;

export async function registerAccountWebhook(
  endpoint: ChatwootEndpoint,
  webhookUrl: string,
  secret: string,
): Promise<ChatwootWebhookRecord> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/webhooks`,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      api_access_token: endpoint.accessToken,
      'Content-Type': 'application/json',
    },
    // Documented request shape wraps params under `webhook`; `secret`
    // is only honored by versions that support signed deliveries.
    body: JSON.stringify({
      webhook: {
        url: webhookUrl,
        subscriptions: [...CHATWOOT_WEBHOOK_SUBSCRIPTIONS],
        secret,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as Record<string, unknown>;
  const record =
    (body.webhook as Record<string, unknown> | undefined) ?? body;
  return {
    id: Number(record.id ?? 0),
    url: String(record.url ?? webhookUrl),
    secret: typeof record.secret === 'string' ? record.secret : undefined,
  };
}

function parseWebhookList(body: unknown): ChatwootWebhookRecord[] {
  // Envelope varies across versions: a bare array, { payload: [] }, or
  // { payload: { webhooks: [] } } (current fazer.ai fork).
  let rows: unknown = body;
  if (!Array.isArray(rows)) {
    const payload = (rows as { payload?: unknown } | null)?.payload;
    rows = Array.isArray(payload)
      ? payload
      : ((payload as { webhooks?: unknown[] } | undefined)?.webhooks ?? []);
  }
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, unknown>>)
    .map((row) => ({ id: Number(row?.id ?? 0), url: String(row?.url ?? '') }))
    .filter((row) => row.id > 0 && row.url !== '');
}

export async function listAccountWebhooks(
  endpoint: ChatwootEndpoint,
): Promise<ChatwootWebhookRecord[]> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/webhooks`,
  );
  const response = await fetch(url, {
    headers: { api_access_token: endpoint.accessToken },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await parseError(response);
  return parseWebhookList(await response.json());
}

/**
 * Remove any account webhook(s) pointing at `webhookUrl`. Best-effort
 * cleanup on disconnect — used instead of storing Chatwoot's webhook
 * id locally, so no extra column is needed.
 *
 * Matching compares the URL PATH only (`/api/chatwoot/webhook/{id}`),
 * not the origin: reconnecting after a domain change (dev tunnel →
 * production host) must still sweep away webhooks left under the old
 * host, which an absolute-URL comparison would miss.
 */
export async function deleteWebhooksByUrl(
  endpoint: ChatwootEndpoint,
  webhookUrl: string,
): Promise<void> {
  let targetPath: string | null = null;
  try {
    targetPath = new URL(webhookUrl).pathname.replace(/\/+$/, '');
  } catch {
    return; // Malformed input — nothing safe to match against.
  }
  try {
    const existing = await listAccountWebhooks(endpoint);
    for (const hook of existing) {
      let hookPath: string;
      try {
        hookPath = new URL(hook.url).pathname.replace(/\/+$/, '');
      } catch {
        continue; // Unparseable stored URL — leave it alone.
      }
      if (hookPath === targetPath) {
        const url = joinUrl(
          endpoint.baseUrl,
          `/api/v1/accounts/${endpoint.chatwootAccountId}/webhooks/${hook.id}`,
        );
        await fetch(url, {
          method: 'DELETE',
          headers: { api_access_token: endpoint.accessToken },
          signal: AbortSignal.timeout(15_000),
        });
      }
    }
  } catch {
    // Non-fatal: leftover webhooks just receive 401s until removed.
  }
}

// ------------------------------------------------------------
// Baileys inbox lifecycle (unofficial WhatsApp pairing).
//
// The fazer.ai fork drives WhatsApp sessions through its Baileys
// provider. Everything happens on Channel::Whatsapp inboxes:
//
//   POST /inboxes                          → create (provider:'baileys')
//   POST /inboxes/{id}/setup_channel_provider → start/refresh session
//                                             (QR arrives asynchronously
//                                             via Chatwoot's own webhook)
//   GET  /inboxes/{id}                     → payload carries
//                                             `provider_connection`:
//                                             { connection: 'open'|'close'|...,
//                                               qr_data_url?, error? }
//   POST /inboxes/{id}/disconnect_channel_provider → logout session
//
// NOTE: qr_data_url and error are only included when the request is
// made with an ADMINISTRATOR token of that Chatwoot account — which
// our stored connection token always is (verify step requires admin).
// ------------------------------------------------------------

export interface BaileysInboxCreated {
  id: number;
  name: string;
}

/**
 * Create a WhatsApp inbox bound to a Baileys session. `phoneNumber`
 * must be E.164 — it becomes globally unique across the whole Chatwoot
 * instance (one number = one inbox), so duplicates surface as 422s we
 * pass through to the caller.
 */
export async function createBaileysInbox(
  endpoint: ChatwootEndpoint,
  options: { phoneNumber: string; name?: string },
): Promise<BaileysInboxCreated> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/inboxes`,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      api_access_token: endpoint.accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: options.name?.trim() || `WhatsApp ${options.phoneNumber}`,
      channel: {
        type: 'whatsapp',
        phone_number: options.phoneNumber,
        provider: 'baileys',
        // Mirror the fork's own defaults from BaileysWhatsapp.vue.
        provider_config: {
          mark_as_read: true,
          presence_subscribe: false,
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await parseError(response);

  const body = (await response.json()) as Record<string, unknown>;
  return { id: Number(body.id ?? 0), name: String(body.name ?? '') };
}

/**
 * Kick off (or refresh) the Baileys session for an inbox. Returns once
 * Chatwoot has forwarded the request to baileys-api; the QR code shows
 * up moments later inside `provider_connection` — poll getInboxProviderState.
 *
 * Re-running this while a pairing is stuck discards the stale session
 * and issues a fresh QR (same behavior as the fork's pairing screen).
 */
export async function setupInboxProvider(
  endpoint: ChatwootEndpoint,
  inboxId: number,
): Promise<void> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/inboxes/${inboxId}/setup_channel_provider`,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { api_access_token: endpoint.accessToken },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await parseError(response);
}

/** Parsed view of an inbox's `provider_connection` blob. */
export interface InboxProviderState {
  /** 'open' | 'close' | 'connecting' | undefined before first event. */
  connection?: string;
  /** Ready-to-render PNG data URL of the pending QR (admin-only field). */
  qrDataUrl?: string;
  /** Session error string surfaced by the fork (admin-only field). */
  error?: string;
}

function parseProviderConnection(raw: unknown): InboxProviderState {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  return {
    connection: typeof record.connection === 'string' ? record.connection : undefined,
    qrDataUrl:
      typeof record.qr_data_url === 'string' && record.qr_data_url.startsWith('data:')
        ? record.qr_data_url
        : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
}

/**
 * Read the current Baileys session state for an inbox. The inbox show
 * payload exposes `provider_connection` at the top level (kept fresh by
 * Chatwoot's internal baileys webhooks).
 */
export async function getInboxProviderState(
  endpoint: ChatwootEndpoint,
  inboxId: number,
): Promise<InboxProviderState> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/inboxes/${inboxId}`,
  );
  const response = await fetch(url, {
    headers: { api_access_token: endpoint.accessToken },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await parseError(response);

  const body = (await response.json()) as Record<string, unknown>;
  return parseProviderConnection(body.provider_connection);
}

/**
 * Log the inbox's WhatsApp session out at the baileys-api. Fail-open,
 * mirroring the upstream controller: the caller only needs the attempt
 * made; a missing (404) or unhappy provider must not block disconnecting.
 */
export async function disconnectInboxProvider(
  endpoint: ChatwootEndpoint,
  inboxId: number,
): Promise<void> {
  const url = joinUrl(
    endpoint.baseUrl,
    `/api/v1/accounts/${endpoint.chatwootAccountId}/inboxes/${inboxId}/disconnect_channel_provider`,
  );
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { api_access_token: endpoint.accessToken },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(
        `[chatwoot/api] disconnect_channel_provider non-success status=${response.status}`,
      );
    }
  } catch (err) {
    console.warn(
      '[chatwoot/api] disconnect_channel_provider failed (ignored):',
      err instanceof Error ? err.message : err,
    );
  }
}

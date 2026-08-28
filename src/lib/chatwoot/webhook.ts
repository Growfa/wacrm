// ============================================================
// Chatwoot inbound webhook — signature verification and payload
// normalization for the unofficial WhatsApp channel.
//
// Chatwoot signs account-webhook deliveries with the secret set at
// registration time:
//   X-Chatwoot-Timestamp: <unix seconds>
//   X-Chatwoot-Signature: sha256=<hex of HMAC-SHA256(secret, ts.body)>
//
// Only two event families matter to wacrm:
//   message_created  — a message landed (we process INCOMING only;
//                      gateway mode means every outgoing echo is ours)
//   message_updated  — delivery/read status advanced on our sends
// Everything else (contact_*, conversation_*, typing…) is ignored.
// ============================================================

import crypto from 'node:crypto';

/**
 * Verify a Chatwoot webhook delivery. `secret` is the per-connection
 * webhook secret (decrypted from chatwoot_connections.webhook_secret).
 *
 * Fails closed on any missing/malformed input. Constant-time compare.
 */
export function verifyChatwootSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!timestampHeader || !signatureHeader || !secret) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', secret)
      .update(`${timestampHeader}.${rawBody}`)
      .digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------
// Webhook payload types — the documented subset we consume.
// Field shapes vary slightly across Chatwoot versions, so most
// fields are optional and read defensively.
// ------------------------------------------------------------

export interface ChatwootAttachment {
  id?: number;
  /** Human channel type: image | video | audio | file | location | … */
  file_type?: string;
  /** Downloadable URL (signed storage link). */
  data_url?: string;
  extension?: string;
}

export interface ChatwootWebhookMessage {
  id: number;
  content?: string | null;
  /** 'incoming' | 'outgoing' | 'template' */
  message_type?: string | number;
  content_type?: string;
  content_attributes?: Record<string, unknown>;
  private?: boolean;
  status?: string;
  created_at?: string | number;
  attachments?: ChatwootAttachment[];
  sender?: {
    id?: number;
    name?: string;
    phone_number?: string;
  };
  conversation?: ChatwootConversationPayload;
}

export interface ChatwootConversationPayload {
  id?: number;
  display_id?: number;
  inbox_id?: number;
  status?: string;
  meta?: {
    sender?: { phone_number?: string; name?: string };
  };
}

export interface ChatwootWebhookPayload {
  event?: string;
  id?: number;
  account?: { id?: number };
  inbox?: { id?: number };
  /** Top-level contact on message_created (varies by version). */
  sender?: {
    id?: number;
    name?: string;
    phone_number?: string;
  };
  conversation?: ChatwootConversationPayload;
  // message_created/message_updated deliver the message fields at the
  // top level AND nest the conversation under `.conversation`.
  [key: string]: unknown;
}

/** The normalized shape the webhook route persists from. */
export interface NormalizedInbound {
  messageId: number;
  senderPhone: string;
  senderName: string;
  conversationDisplayId: number;
  inboxId: number;
  /**
   * Who authored the message. `customer` for messages that reached the
   * paired number from the outside; `agent` for messages sent by the
   * agent from the connected WhatsApp app (the gateway echoes these
   * back, and we persist them so manual phone replies stay visible in
   * the CRM thread).
   */
  senderType: 'customer' | 'agent';
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document';
  contentText: string | null;
  attachmentUrl: string | null;
  attachmentFilename: string | null;
  createdAtIso: string;
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Resolve the customer's phone from a message_created payload.
 * Preference order mirrors how Chatwoot populates senders:
 *   1. top-level sender.phone_number
 *   2. nested conversation.meta.sender.phone_number
 *
 * For `outgoing` messages the top-level sender is the *agent* (the
 * paired number), so the customer is instead the conversation's meta
 * sender — pass `outgoing: true` to flip the preference.
 */
export function extractSenderPhone(
  payload: ChatwootWebhookPayload,
  outgoing = false,
): string | null {
  const dir = payload.sender?.phone_number;
  const nested = payload.conversation?.meta?.sender?.phone_number;
  const raw = outgoing ? nested || dir : dir || nested;
  if (!raw) return null;
  const digits = digitsOnly(raw);
  return digits.length >= 8 ? digits : null;
}

const ATTACHMENT_KIND_MAP: Record<string, NormalizedInbound['contentType']> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  voice_note: 'audio',
  file: 'document',
  document: 'document',
};

/**
 * Normalize a message_created payload into the shape the
 * persistence pipeline expects. Returns null when the payload isn't a
 * persistable message (no id, no sender phone, template notices, echo
 * of a CRM-sent reply that is already persisted upstream).
 *
 * Both customer-authored and agent-authored (outgoing from the paired
 * number) messages are retained; the caller decides whether to bump
 * unread/reopen for agent messages and to dedupe its own sends.
 */
export function normalizeIncomingMessage(
  payload: ChatwootWebhookPayload,
): NormalizedInbound | null {
  const messageTypeRaw = payload.message_type as string | number | undefined;
  const isOutgoing =
    messageTypeRaw === 'outgoing' ||
    messageTypeRaw === 'template' ||
    messageTypeRaw === 1;
  // Template notices carry no per-message thread text we can attribute
  // to a customer or agent — nothing to persist.
  if (isOutgoing && messageTypeRaw === 'template') return null;

  const messageId = Number(payload.id);
  if (!messageId) return null;

  const senderPhone = extractSenderPhone(payload, isOutgoing);
  if (!senderPhone) return null;

  const displayId = Number(
    payload.conversation?.display_id ?? payload.conversation?.id ?? 0,
  );
  if (!displayId) return null;

  const inboxId = Number(
    payload.inbox?.id ?? payload.conversation?.inbox_id ?? 0,
  );

  const senderName =
    ((payload.sender?.name || payload.conversation?.meta?.sender?.name) ?? '')
      .toString()
      .trim();

  // Content: plain text or a caption on the first attachment.
  const attachments = (payload.attachments ?? []) as ChatwootAttachment[];
  const first = attachments.length > 0 ? attachments[0] : null;
  const rawContent = typeof payload.content === 'string' ? payload.content : '';
  const contentText = rawContent.trim() !== '' ? rawContent.trim() : null;

  let contentType: NormalizedInbound['contentType'] = 'text';
  let attachmentUrl: string | null = null;
  let attachmentFilename: string | null = null;
  if (first && first.data_url) {
    attachmentUrl = first.data_url;
    attachmentFilename = buildAttachmentFilename(first);
    contentType =
      ATTACHMENT_KIND_MAP[first.file_type ?? 'file'] ?? 'document';
  }

  // created_at arrives either as ISO-ish text ("2026-08-24 12:00:00 UTC")
  // or unix seconds depending on version — parse defensively.
  let createdAtIso = new Date().toISOString();
  const rawCreated = payload.created_at;
  if (typeof rawCreated === 'number') {
    const ms = rawCreated < 10_000_000_000 ? rawCreated * 1000 : rawCreated;
    const parsed = new Date(ms).toISOString();
    if (!Number.isNaN(Date.parse(parsed))) createdAtIso = parsed;
  } else if (typeof rawCreated === 'string') {
    const parsed = new Date(rawCreated.replace(' UTC', 'Z').replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) createdAtIso = parsed.toISOString();
  }

  return {
    messageId,
    senderPhone,
    senderName,
    conversationDisplayId: displayId,
    inboxId,
    senderType: isOutgoing ? 'agent' : 'customer',
    contentType,
    contentText,
    attachmentUrl,
    attachmentFilename,
    createdAtIso,
  };
}

/** Map a Chatwoot message_updated status onto our messages.status enum. */
export function normalizeStatusUpdate(
  payload: ChatwootWebhookPayload,
): { messageId: number; status: 'sent' | 'delivered' | 'read' | 'failed' } | null {
  const messageId = Number(payload.id);
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (
    !messageId ||
    !(['sent', 'delivered', 'read', 'failed'] as const).includes(
      status as 'sent',
    )
  ) {
    return null;
  }
  return { messageId, status: status as 'sent' | 'delivered' | 'read' | 'failed' };
}

function buildAttachmentFilename(attachment: ChatwootAttachment): string {
  const urlPart = attachment.data_url?.split('/').pop()?.split('?')[0] ?? '';
  const ext = attachment.extension ? `.${attachment.extension}` : '';
  const base = urlPart && /\.[a-z0-9]{2,5}$/i.test(urlPart)
    ? urlPart
    : `${urlPart || 'attachment'}${ext}`;
  // Strip any signed-URL path noise down to something readable.
  return base.slice(0, 120) || 'attachment';
}

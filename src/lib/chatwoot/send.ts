// ============================================================
// Chatwoot channel — outbound send adapter (migration 037).
//
// The gateway-mode counterpart of `sendMessageToConversation`'s Meta
// plumbing. Given an already-resolved conversation + contact, this:
//   1. loads the account's active chatwoot_connections row,
//   2. resolves the Chatwoot conversation display_id (must have been
//      linked by a prior inbound message),
//   3. sends text / media through the Chatwoot Application API,
//   4. persists the message via the SHARED persist helper so both
//      transports write identical rows.
//
// Templates and interactive payloads are Cloud-API concepts with no
// MVP equivalent here — they throw a typed SendMessageError the
// routes already know how to render.
//
// Imported by send-message.ts via dynamic import (this module imports
// SendMessageError/persistSentAgentMessage back from it).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import {
  SendMessageError,
  persistSentAgentMessage,
} from '@/lib/whatsapp/send-message';
import {
  createConversationMessage,
  fetchAttachmentBytes,
  type ChatwootEndpoint,
} from '@/lib/chatwoot/api';

/** Row subset of chatwoot_connections the sender needs. */
export interface ActiveChatwootConnection extends ChatwootEndpoint {
  id: string;
  inboxId: number | null;
  /** Display copy of the bound number (re-pair detection, UI labels). */
  inboxPhone: string | null;
  status: string;
}

/**
 * Load the account's active Chatwoot connection, or null when the
 * account isn't on the gateway (→ the caller falls back to Meta).
 * Decrypts the stored token.
 */
export async function getActiveChatwootConnection(
  db: SupabaseClient,
  accountId: string
): Promise<ActiveChatwootConnection | null> {
  const { data, error } = await db
    .from('chatwoot_connections')
    .select(
      'id, base_url, chatwoot_account_id, api_access_token, inbox_id, inbox_phone, status'
    )
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .maybeSingle();

  if (error) {
    console.error('[chatwoot] failed to load connection:', error.message);
    return null;
  }
  if (!data) return null;

  let accessToken: string;
  try {
    accessToken = decrypt(data.api_access_token);
  } catch {
    console.error(
      '[chatwoot] api_access_token decryption failed — check ENCRYPTION_KEY'
    );
    return null;
  }

  return {
    id: data.id,
    baseUrl: data.base_url,
    chatwootAccountId: data.chatwoot_account_id,
    accessToken,
    inboxId: data.inbox_id ?? null,
    inboxPhone: data.inbox_phone ?? null,
    status: data.status,
  };
}

export interface ChatwootSendParams {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
}

/**
 * Send an agent reply through the Chatwoot gateway and persist it.
 *
 * `connection` comes preloaded from `getActiveChatwootConnection` (the
 * caller's dispatch step owns that lookup); `conversation` must be the
 * already-loaded row WITH its contact so both channels share identical
 * validation semantics. Returns the same shape as the Meta path.
 */
export async function sendMessageViaChatwoot(
  db: SupabaseClient,
  accountId: string,
  conversation: { id: string; chatwoot_conversation_id?: number | null },
  contact: { id: string; phone: string },
  params: ChatwootSendParams,
  connection: ActiveChatwootConnection
): Promise<{ messageId: string; whatsappMessageId: string }> {
  const { messageType, contentText, mediaUrl, filename } = params;

  // Feature gate: templates / interactive are Meta-only in this
  // release. The composer hides these affordances for gateway
  // accounts; this guards API callers.
  const unsupported =
    messageType === 'template'
      ? 'Message templates are not supported on the Chatwoot channel yet'
      : messageType === 'interactive'
        ? 'Interactive messages are not supported on the Chatwoot channel yet'
        : null;
  if (unsupported) {
    throw new SendMessageError('unsupported_channel', unsupported, 400);
  }

  // A gateway conversation must have been opened by an inbound message
  // — otherwise we don't know which Chatwoot thread to post into
  // (business-initiated outreach is a phase-2 feature anyway).
  const displayId = conversation.chatwoot_conversation_id ?? null;
  if (!displayId) {
    throw new SendMessageError(
      'chatwoot_not_linked',
      'This conversation has no WhatsApp history yet. Ask the customer to message you first.',
      400
    );
  }

  // Phone sanity mirrors the Meta path (same normalization, same
  // E.164 check) so contacts stay interchangeable across channels.
  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError('bad_request', 'Invalid phone number format', 400);
  }

  const isMediaKind = ['image', 'video', 'document', 'audio'].includes(
    messageType
  );

  const attachment = isMediaKind
    ? await fetchOutboundAttachment(mediaUrl!, filename)
    : null;

  let chatwootMessageId: string;
  try {
    const result = await createConversationMessage({
      baseUrl: connection.baseUrl,
      chatwootAccountId: connection.chatwootAccountId,
      accessToken: connection.accessToken,
      conversationId: displayId,
      content: contentText || undefined,
      attachment: attachment ?? undefined,
    });
    chatwootMessageId = String(result.id);
  } catch (err) {
    if (err instanceof SendMessageError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[chatwoot] send failed:', message);
    throw new SendMessageError(
      'chatwoot_error',
      `Chatwoot API error: ${message}`,
      502
    );
  }

  // Persist through the shared helper — identical rows across channels.
  const { messageId } = await persistSentAgentMessage(db, {
    accountId,
    contactId: contact.id,
    conversationId: conversation.id,
    insertRow: {
      content_type: isMediaKind ? messageType : 'text',
      content_text: contentText ?? null,
      media_url: mediaUrl || null,
      template_name: null,
      interactive_payload: null,
      message_id: chatwootMessageId,
      reply_to_message_id: null,
      channel: 'chatwoot',
    },
    lastMessageText: contentText || `[${messageType}]`,
  });

  return { messageId, whatsappMessageId: chatwootMessageId };
}

/** Download outbound media so it can be multipart-uploaded to Chatwoot. */
async function fetchOutboundAttachment(
  mediaUrl: string,
  filename: string | null | undefined
): Promise<{ bytes: Uint8Array; filename: string; contentType: string }> {
  try {
    const fetched = await fetchAttachmentBytes(mediaUrl);
    const ext =
      filename?.match(/\.[a-z0-9]{1,5}$/i)?.[0] ??
      guessExtension(fetched.contentType);
    return {
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      filename: filename || `attachment${ext}`,
    };
  } catch (err) {
    if (err instanceof SendMessageError) throw err;
    throw new SendMessageError(
      'media_error',
      `Failed to fetch media for upload: ${
        err instanceof Error ? err.message : err
      }`,
      502
    );
  }
}

function guessExtension(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
  };
  return map[contentType.split(';')[0]] ?? '';
}

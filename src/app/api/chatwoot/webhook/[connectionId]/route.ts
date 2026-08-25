// ============================================================
// POST /api/chatwoot/webhook/[connectionId] — inbound pipeline for
// the unofficial WhatsApp channel (migration 037).
//
// Each wacrm connection registers ONE account-level webhook on its
// Chatwoot instance pointing at THIS route with its own id in the
// path. That gives every registration a unique, addressable URL:
//   - the HMAC secret to verify with is resolved from the path (no
//     trial-and-error across rows),
//   - re-saves / disconnects can clean up their registration by URL
//     without touching sibling connections that share the same
//     Chatwoot account.
//
// Note the registration is at the Chatwoot ACCOUNT level, so this URL
// still receives events for every inbox under that account — events
// whose inbox belongs to a different wacrm connection are verified
// and then silently dropped by the ownership gate below.
//
// Consumed events:
//   message_created → persist the customer's message into the inbox
//   message_updated → mirror delivery/read status onto our row
//
// Pipeline parity with /api/whatsapp/webhook (Meta): same shared
// identity helpers, same conversation preview/unread updates, same
// reopen-on-reply behavior, same public-API webhook fan-out.
// Deliberately OUT of scope for the gateway channel (phase 2):
// flows, automations, AI auto-reply and broadcast reply-flagging.
// ============================================================

import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  verifyChatwootSignature,
  normalizeIncomingMessage,
  normalizeStatusUpdate,
  type ChatwootWebhookPayload,
} from '@/lib/chatwoot/webhook'
import { fetchAttachmentBytes } from '@/lib/chatwoot/api'
import { buildMediaPath } from '@/lib/storage/upload-media'
import {
  findOrCreateContact,
  findOrCreateConversation,
} from '@/lib/channels/inbound-identity'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConnectionRow = any

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params

  // Read raw body first so we can HMAC-verify the exact bytes
  // Chatwoot signed. request.json() would re-encode and break it.
  const rawBody = await request.text()
  const timestampHeader = request.headers.get('x-chatwoot-timestamp')
  const signatureHeader = request.headers.get('x-chatwoot-signature')

  let payload: ChatwootWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Resolve the connection named by the path. A removed/disconnected
  // row stops accepting deliveries immediately (404), which also makes
  // stale registrations visible in Chatwoot's delivery dashboard.
  const { data: connection } = await supabaseAdmin()
    .from('chatwoot_connections')
    .select('id, account_id, created_by, inbox_id, webhook_secret')
    .eq('id', connectionId)
    .eq('status', 'connected')
    .maybeSingle()

  if (!connection) {
    console.warn('[chatwoot-webhook] unknown or disconnected connection:', connectionId)
    return NextResponse.json({ error: 'Unknown connection' }, { status: 404 })
  }

  // Fail closed (401), loudly, so a broken secret shows up in
  // Chatwoot's delivery dashboard instead of silently eating events.
  let secret: string
  try {
    secret = decrypt(connection.webhook_secret)
  } catch {
    console.error('[chatwoot-webhook] webhook_secret decryption failed:', connectionId)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!verifyChatwootSignature(rawBody, timestampHeader, signatureHeader, secret)) {
    console.warn('[chatwoot-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Ack fast; process inside after() exactly like the Meta webhook
  // (a slow ack triggers Chatwoot retries + duplicate inserts, while a
  // detached promise isn't guaranteed to finish on serverless).
  const conn = connection
  after(async () => {
    try {
      // Inbox-ownership gate: account-level webhooks receive events
      // for EVERY inbox under the Chatwoot account — including ones
      // bound to other wacrm connections sharing the instance. Only
      // our bound inbox's events belong here (unbound rows accept
      // anything — single-inbox deployments).
      const eventInboxId = Number(
        payload.inbox?.id ?? payload.conversation?.inbox_id ?? 0
      )
      if (
        eventInboxId &&
        conn.inbox_id &&
        Number(conn.inbox_id) !== eventInboxId
      ) {
        return
      }
      await processEvent(payload, conn)
    } catch (error) {
      console.error('[chatwoot-webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ received: true }, { status: 200 })
}

async function processEvent(
  payload: ChatwootWebhookPayload,
  connection: ConnectionRow
) {
  switch (payload.event) {
    case 'message_created':
      await handleIncomingMessage(payload, connection)
      break
    case 'message_updated':
      await handleStatusUpdate(payload)
      break
    default:
      // contact_*, conversation_*, typing… — nothing to persist yet.
      break
  }
}

/**
 * Mirror a Chatwoot delivery/read transition onto our outbound row.
 * Scoped to channel='chatwoot' because numeric Chatwoot ids and Meta
 * wamids live in the same non-unique message_id column.
 */
async function handleStatusUpdate(payload: ChatwootWebhookPayload) {
  const update = normalizeStatusUpdate(payload)
  if (!update) return

  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status: update.status })
    .eq('message_id', String(update.messageId))
    .eq('channel', 'chatwoot')

  if (error) {
    console.error('[chatwoot-webhook] status update failed:', error.message)
  }
}

async function handleIncomingMessage(
  payload: ChatwootWebhookPayload,
  connection: ConnectionRow
) {
  const normalized = normalizeIncomingMessage(payload)
  // Outgoing echo of our own send / template notice / no phone → skip.
  if (!normalized) return

  const accountId = connection.account_id
  // Audit FK owner for new rows — the admin who connected the inbox.
  const ownerUserId = connection.created_by
  if (!ownerUserId) {
    console.error(
      '[chatwoot-webhook] connection has no created_by; cannot attribute inserts',
      connection.id
    )
    return
  }

  // ---- Contact + conversation (shared helpers, identical semantics
  // ---- to the Meta pipeline).
  const contactOutcome = await findOrCreateContact(
    supabaseAdmin(),
    accountId,
    ownerUserId,
    normalized.senderPhone,
    normalized.senderName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    supabaseAdmin(),
    accountId,
    ownerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Link the thread to its Chatwoot display_id (the outbound adapter
  // posts replies straight to it). Backfills legacy threads too.
  if (conversation.chatwoot_conversation_id !== normalized.conversationDisplayId) {
    const { error: linkError } = await supabaseAdmin()
      .from('conversations')
      .update({ chatwoot_conversation_id: normalized.conversationDisplayId })
      .eq('id', conversation.id)
    if (linkError) {
      console.error('[chatwoot-webhook] failed to link display_id:', linkError.message)
    }
  }

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // ---- Media: pull the attachment out of Chatwoot's signed URL into
  // ---- our own public bucket so access control + retention stay ours.
  let mediaUrl: string | null = null
  if (normalized.attachmentUrl) {
    mediaUrl = await storeInboundAttachment(accountId, normalized)
  }

  // ---- Persist the customer's message.
  const { error: msgError } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: normalized.contentType,
      content_text: normalized.contentText,
      media_url: mediaUrl,
      message_id: String(normalized.messageId),
      status: 'delivered',
      created_at: normalized.createdAtIso,
      channel: 'chatwoot',
    })

  if (msgError) {
    console.error('[chatwoot-webhook] error inserting message:', msgError)
    return
  }

  // Preview + unread badge, mirroring the Meta pipeline.
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text:
        normalized.contentText || `[${normalized.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[chatwoot-webhook] error updating conversation:', convError)
  }

  // Customer writing again re-opens the thread (issue #409 parity).
  await reopenClosedConversation(supabaseAdmin(), conversation)

  // Public-API fan-out. (Flows/automations/AI intentionally not wired
  // for this channel yet — see the file header.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: String(normalized.messageId),
    content_type: normalized.contentType,
    text: normalized.contentText,
  })
}

/**
 * Download an inbound attachment from Chatwoot and copy it into the
 * account-scoped chat-media bucket. Best-effort: on any failure we log
 * and return null so the message still lands (as text/caption only).
 */
async function storeInboundAttachment(
  accountId: string,
  normalized: NonNullable<ReturnType<typeof normalizeIncomingMessage>>
): Promise<string | null> {
  try {
    const fetched = await fetchAttachmentBytes(normalized.attachmentUrl!)
    const filename =
      normalized.attachmentFilename || `attachment-${normalized.messageId}`
    const path = buildMediaPath(accountId, filename)
    const blob = new Blob([new Uint8Array(fetched.bytes)], {
      type: fetched.contentType,
    })

    const { error: upErr } = await supabaseAdmin()
      .storage.from('chat-media')
      .upload(path, blob, {
        cacheControl: '3600',
        upsert: false,
        contentType: fetched.contentType,
      })
    if (upErr) throw upErr

    const { data } = supabaseAdmin()
      .storage.from('chat-media')
      .getPublicUrl(path)
    return data.publicUrl
  } catch (err) {
    console.error(
      '[chatwoot-webhook] attachment download/upload failed:',
      err instanceof Error ? err.message : err
    )
    return null
  }
}

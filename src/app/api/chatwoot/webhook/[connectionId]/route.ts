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

const LOG = '[chatwoot-webhook]'

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

  console.log(`${LOG} incoming delivery for connectionId=${connectionId} body_len=${rawBody.length} has_timestamp=${!!timestampHeader} has_signature=${!!signatureHeader}`)

  let payload: ChatwootWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    console.warn(`${LOG} invalid JSON body`)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Log event type early so we can trace what Chatwoot is sending.
  console.log(`${LOG} event=${payload.event ?? '(none)'} id=${payload.id ?? '(none)'} inbox_id=${payload.inbox?.id ?? payload.conversation?.inbox_id ?? '(none)'}`)

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
    console.warn(`${LOG} unknown or disconnected connection: ${connectionId}`)
    return NextResponse.json({ error: 'Unknown connection' }, { status: 404 })
  }

  console.log(`${LOG} connection found: inbox_id=${connection.inbox_id} account_id=${connection.account_id} has_secret=${!!connection.webhook_secret}`)

  // Fail closed (401), loudly, so a broken secret shows up in
  // Chatwoot's delivery dashboard instead of silently eating events.
  let secret: string
  try {
    secret = decrypt(connection.webhook_secret)
  } catch (err) {
    console.error(`${LOG} webhook_secret decryption FAILED for connection ${connectionId}:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!verifyChatwootSignature(rawBody, timestampHeader, signatureHeader, secret)) {
    console.warn(`${LOG} HMAC verification FAILED — stored secret length=${secret.length} timestamp=${timestampHeader} signature=${signatureHeader?.slice(0, 30)}…`)
    console.warn(`${LOG} HINT: Chatwoot may be using a different secret than what is stored. Run GET /api/chatwoot/debug to compare.`)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  console.log(`${LOG} HMAC verification PASSED — processing event`)

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
        console.log(`${LOG} inbox ownership gate: event inbox_id=${eventInboxId} ≠ bound inbox_id=${conn.inbox_id} — DROPPED`)
        return
      }
      await processEvent(payload, conn)
    } catch (error) {
      console.error(`${LOG} processing failed:`, error)
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
      console.log(`${LOG} processing message_created event`)
      await handleIncomingMessage(payload, connection)
      break
    case 'message_updated':
      console.log(`${LOG} processing message_updated event`)
      await handleStatusUpdate(payload)
      break
    default:
      console.log(`${LOG} ignoring event type: ${payload.event}`)
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
  if (!update) {
    console.log(`${LOG} normalizeStatusUpdate returned null for event message_updated`)
    return
  }

  console.log(`${LOG} status update: msgId=${update.messageId} new_status=${update.status}`)

  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status: update.status })
    .eq('message_id', String(update.messageId))
    .eq('channel', 'chatwoot')

  if (error) {
    console.error(`${LOG} status UPDATE failed:`, error.message)
  }
}

async function handleIncomingMessage(
  payload: ChatwootWebhookPayload,
  connection: ConnectionRow
) {
  const normalized = normalizeIncomingMessage(payload)
  // Outgoing echo of our own send / template notice / no phone → skip.
  if (!normalized) {
    // Log why normalization failed so operators can debug fork-specific
    // payload shapes that don't match our expected schema.
    const messageTypeRaw = payload.message_type as string | number | undefined
    const isOutgoing = messageTypeRaw === 'outgoing' || messageTypeRaw === 'template' || messageTypeRaw === 1
    const hasPhone = !!(payload.sender?.phone_number || payload.conversation?.meta?.sender?.phone_number)
    const hasDisplayId = !!(payload.conversation?.display_id || payload.conversation?.id)
    const hasId = !!payload.id
    console.log(`${LOG} normalizeIncomingMessage returned null — message_type=${messageTypeRaw} is_outgoing=${isOutgoing} has_phone=${hasPhone} has_display_id=${hasDisplayId} has_id=${hasId} event_id=${payload.id}`)
    return
  }

  console.log(`${LOG} normalized: msgId=${normalized.messageId} phone=${normalized.senderPhone} displayId=${normalized.conversationDisplayId} contentType=${normalized.contentType} inboxId=${normalized.inboxId}`)

  const accountId = connection.account_id
  // Audit FK owner for new rows — the admin who connected the inbox.
  const ownerUserId = connection.created_by
  if (!ownerUserId) {
    console.error(`${LOG} connection has no created_by; cannot attribute inserts`, connection.id)
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
  if (!contactOutcome) {
    console.error(`${LOG} findOrCreateContact returned null for phone=${normalized.senderPhone}`)
    return
  }
  const contactRecord = contactOutcome.contact
  console.log(`${LOG} contact: id=${contactRecord.id} was_created=${contactOutcome.wasCreated} phone=${normalized.senderPhone}`)

  const convResult = await findOrCreateConversation(
    supabaseAdmin(),
    accountId,
    ownerUserId,
    contactRecord.id
  )
  if (!convResult) {
    console.error(`${LOG} findOrCreateConversation returned null for contact_id=${contactRecord.id}`)
    return
  }
  const conversation = convResult.conversation
  console.log(`${LOG} conversation: id=${conversation.id} was_created=${convResult.created} existing_woot_id=${conversation.chatwoot_conversation_id} new_woot_id=${normalized.conversationDisplayId}`)

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
    console.error(`${LOG} message INSERT FAILED:`, JSON.stringify(msgError))
    return
  }

  console.log(`${LOG} message INSERTED successfully: id=${normalized.messageId} conv_id=${conversation.id}`)

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

// ============================================================
// Shared inbound identity resolution — used by BOTH webhook
// pipelines (Meta Cloud API and the Chatwoot gateway).
//
// Extracted verbatim from src/app/api/whatsapp/webhook/route.ts when
// the Chatwoot channel landed (migration 037) so the two transports
// can never drift apart on what "same customer" / "same thread"
// means. All queries are account-scoped; callers pass whichever
// SupabaseClient they hold (service-role inside webhook routes).
// ============================================================

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in the caller's pipeline. */
  wasCreated: boolean
}

/**
 * Find or create the account-scoped contact for an inbound sender.
 * Returns null only on unrecoverable DB errors (caller drops the
 * message — same contract as the original inline implementations).
 */
export async function findOrCreateContact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  /** Audit FK owner for new rows (config/connection creator). */
  ownerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // channel config owner as a stable default).
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-identity] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export interface ConversationOutcome {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversation: any
  created: boolean
}

/**
 * Find or create the canonical conversation for a contact (one thread
 * per contact per account — oldest row wins, converging duplicates).
 */
export async function findOrCreateConversation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  ownerUserId: string,
  contactId: string
): Promise<ConversationOutcome | null> {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and treating any error as "none found"
  // would insert a new row — once two conversations existed for a
  // contact (from a race), every subsequent inbound message errored on
  // the lookup and snowballed into duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve
  // to the same canonical survivor the dedup migration (036) keeps, so
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound-identity] error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error(
      '[inbound-identity] error creating conversation:',
      createError
    )
    return null
  }

  return { conversation: newConv, created: true }
}

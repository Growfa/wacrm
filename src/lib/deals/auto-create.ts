// ============================================================
// Automatic "New Lead" deal creation for inbound contacts.
//
// wacrm has no built-in auto-deal path (deals are created manually
// in the pipeline UI or via a `create_deal` automation step, which
// only runs on the Meta channel). This helper gives both webhook
// pipelines a shared, idempotent way to drop a brand-new inbound
// contact into the account's pipeline first stage (e.g. "New Lead")
// so agents immediately see it on the board.
//
// Invoked from the inbound handlers when `findOrCreateContact`
// reports `wasCreated: true` — i.e. the first message from a brand
// new number. Existing threads (already-created contacts) and
// agent-authored echoes never trigger a deal here.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface NewLeadDealParams {
  accountId: string
  ownerUserId: string
  contact: { id: string; name?: string | null; phone?: string | null }
  conversation: { id: string }
}

/**
 * Create a deal in the account's first pipeline / first stage for a
 * newly-seen inbound contact. Best-effort: returns without throwing on
 * any config gap (no pipeline/stage) or DB error, and never duplicates
 * an existing open deal for the same contact.
 */
export async function ensureNewLeadDeal(
  db: Db,
  { accountId, ownerUserId, contact, conversation }: NewLeadDealParams,
): Promise<{ created: boolean; pipelineId?: string }> {
  // Idempotency: if this contact already has an open deal, don't stack
  // a second one. Guarded best effort — there is no unique partial
  // index on deals.contact_id, so a concurrent race could still double
  // insert, but the pre-check keeps normal flows from accumulating
  // duplicate New Leads.
  const { data: existing, error: existingErr } = await db
    .from('deals')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .eq('status', 'open')
    .maybeSingle()

  if (existingErr) {
    console.error('[auto-deal] error checking existing deal:', existingErr)
    return { created: false }
  }
  if (existing) {
    return { created: false }
  }

  // Resolve the account's pipeline — the oldest-created one is treated
  // as the default (accounts typically have a single "Sales Pipeline").
  const { data: pipelines, error: pipeErr } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (pipeErr) {
    console.error('[auto-deal] error resolving pipeline:', pipeErr)
    return { created: false }
  }
  const pipeline = pipelines && pipelines[0]
  if (!pipeline) {
    console.log('[auto-deal] no pipeline configured for account — skipping')
    return { created: false }
  }

  // First stage of that pipeline = the entry stage ("New Lead").
  const { data: stages, error: stageErr } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })
    .limit(1)

  if (stageErr) {
    console.error('[auto-deal] error resolving first stage:', stageErr)
    return { created: false }
  }
  const stage = stages && stages[0]
  if (!stage) {
    console.log('[auto-deal] pipeline has no stages — skipping')
    return { created: false }
  }

  // Currency: honor the account's configured default (fallback USD),
  // mirroring the automation `create_deal` step.
  const { data: acct } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()

  const title = (contact.name || contact.phone || 'Novo contato').trim()

  const { error: insertErr } = await db.from('deals').insert({
    account_id: accountId,
    user_id: ownerUserId,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
    contact_id: contact.id,
    conversation_id: conversation.id,
    title,
    value: 0,
    currency: acct?.default_currency ?? 'USD',
    status: 'open',
  })

  if (insertErr) {
    console.error('[auto-deal] error creating deal:', insertErr)
    return { created: false }
  }

  console.log(`[auto-deal] created New Lead deal for contact ${contact.id}`)
  return { created: true, pipelineId: pipeline.id }
}

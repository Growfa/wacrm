import { describe, expect, it } from 'vitest'
import { ensureNewLeadDeal } from './auto-create'

type TerminalResult = { data?: unknown; error?: unknown }

// A chained-Supabase mock: `.select`/`.eq`/`.order` are builders that
// keep returning the same chain; the terminal calls (`.limit`,
// `.maybeSingle`, `.insert`) delegate to a per-table handler keyed by
// the method name. Intermediate field values aren't inspected — this
// suite only asserts on terminal behavior.
type Handler = (...args: unknown[]) => TerminalResult

interface MockQuery {
  select: () => MockQuery
  eq: () => MockQuery
  order: () => MockQuery
  limit: () => TerminalResult
  maybeSingle: () => TerminalResult
  insert: (payload: Record<string, unknown>) => TerminalResult
}

function makeDb(handlers: Record<string, Record<string, Handler>>) {
  const from = (table: string): MockQuery => {
    const h = handlers[table] ?? {}
    const terminal = (method: string, ...args: unknown[]): TerminalResult => {
      const fn = h[method]
      if (!fn) return { data: null, error: null }
      return (fn(...args) as TerminalResult) ?? { data: null, error: null }
    }
    const self: MockQuery = {
      select: () => self,
      eq: () => self,
      order: () => self,
      limit: () => terminal('limit'),
      maybeSingle: () => terminal('maybeSingle'),
      insert: (payload: Record<string, unknown>) => terminal('insert', payload),
    }
    return self
  }
  return { from }
}

const ACCOUNT = 'acct-1'
const OWNER = 'user-admin'
const CONTACT = { id: 'contact-1', name: 'Ana Silva', phone: '5511912345678' }
const CONVERSATION = { id: 'conv-1' }

interface State {
  created: boolean
  lastInsert: Record<string, unknown> | null
}

function freshDb(opts: { hasOpenDeal?: boolean; hasPipeline?: boolean; hasStage?: boolean } = {}): { db: ReturnType<typeof makeDb>; state: State } {
  const { hasOpenDeal = false, hasPipeline = true, hasStage = true } = opts
  const state: State = { created: false, lastInsert: null }

  const db = makeDb({
    deals: {
      maybeSingle: () => ({ data: hasOpenDeal ? { id: 'deal-1' } : null, error: null }),
      insert: (payload: unknown): TerminalResult => {
        state.created = true
        state.lastInsert = payload as Record<string, unknown>
        return { data: null, error: null }
      },
    },
    pipelines: {
      limit: () => ({ data: hasPipeline ? [{ id: 'p-1' }] : [], error: null }),
    },
    pipeline_stages: {
      limit: () => ({ data: hasStage ? [{ id: 's-1' }] : [], error: null }),
    },
    accounts: {
      maybeSingle: () => ({ data: { default_currency: 'BRL' }, error: null }),
    },
  })
  return { db, state }
}

describe('ensureNewLeadDeal', () => {
  it('creates an open New-Lead deal tied to the contact + conversation', async () => {
    const { db, state } = freshDb()
    const res = await ensureNewLeadDeal(db, { accountId: ACCOUNT, ownerUserId: OWNER, contact: CONTACT, conversation: CONVERSATION })
    expect(res.created).toBe(true)
    expect(res.pipelineId).toBe('p-1')
    expect(state.lastInsert).toMatchObject({
      account_id: ACCOUNT,
      user_id: OWNER,
      pipeline_id: 'p-1',
      stage_id: 's-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      title: 'Ana Silva',
      value: 0,
      currency: 'BRL',
      status: 'open',
    })
  })

  it('does not create a second deal when an open deal already exists', async () => {
    const { db, state } = freshDb({ hasOpenDeal: true })
    const res = await ensureNewLeadDeal(db, { accountId: ACCOUNT, ownerUserId: OWNER, contact: CONTACT, conversation: CONVERSATION })
    expect(res.created).toBe(false)
    expect(state.created).toBe(false)
  })

  it('falls back to the phone for the title when there is no name', async () => {
    const { db, state } = freshDb()
    await ensureNewLeadDeal(db, { accountId: ACCOUNT, ownerUserId: OWNER, contact: { id: 'c2', phone: '5511987654321' }, conversation: CONVERSATION })
    expect(state.lastInsert?.title).toBe('5511987654321')
  })

  it('skips when the account has no pipeline', async () => {
    const { db, state } = freshDb({ hasPipeline: false })
    const res = await ensureNewLeadDeal(db, { accountId: ACCOUNT, ownerUserId: OWNER, contact: CONTACT, conversation: CONVERSATION })
    expect(res.created).toBe(false)
    expect(state.created).toBe(false)
  })

  it('skips when the pipeline has no stages', async () => {
    const { db, state } = freshDb({ hasStage: false })
    const res = await ensureNewLeadDeal(db, { accountId: ACCOUNT, ownerUserId: OWNER, contact: CONTACT, conversation: CONVERSATION })
    expect(res.created).toBe(false)
    expect(state.created).toBe(false)
  })
})

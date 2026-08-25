-- ============================================================
-- 037_chatwoot_channel — Unofficial WhatsApp via Chatwoot gateway
--
-- Adds a second transport channel alongside the official Meta
-- Cloud API. The Chatwoot instance (self-hosted, fazer.ai fork)
-- owns the WhatsApp connection (Baileys inbox); wacrm talks to it
-- over the Application REST API and receives inbound events on an
-- account webhook. This migration is additive — nothing about the
-- Meta path changes.
--
-- Design notes
--   - `chatwoot_connections` is account-scoped (one row per wacrm
--     account), mirroring `whatsapp_config`: every client binds to
--     ONE inbox of a shared Chatwoot account. All instances can
--     point at the same Chatwoot deployment; nothing prevents two
--     accounts from using different deployments.
--   - `api_access_token` and `webhook_secret` are AES-256-GCM
--     encrypted at rest with the same encrypt()/decrypt() pair as
--     whatsapp_config.access_token.
--   - `inbox_id` is the routing key for inbound webhooks: a
--     message_created payload carries payload.inbox.id, which maps
--     back to exactly one wacrm account. Indexed because the
--     webhook fan-out looks it up on every delivery.
--   - `conversations.chatwoot_conversation_id` caches Chatwoot's
--     display_id so outbound replies POST straight to
--     /conversations/{display_id}/messages without a lookup round
--     trip. Nullable — only set for threads created by (or linked
--     to) the gateway; a NULL on a chatwoot-channel account means
--     "never seen inbound, cannot reply yet".
--   - `messages.channel` records provenance per row ('meta' |
--     'chatwoot'). Defaults to 'meta' so every existing row and
--     every existing insert path behaves exactly as before.
--
-- RLS mirrors whatsapp_config / webhook_endpoints: any member may
-- read (the inbox UI needs connection state); admin+ writes. The
-- webhook processing path uses the service-role client, which
-- bypasses RLS by design.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS chatwoot_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  base_url            text NOT NULL,           -- e.g. https://chatwoot.example.com (no trailing slash)
  chatwoot_account_id integer NOT NULL,        -- numeric Chatwoot account id
  api_access_token    text NOT NULL,           -- AES-256-GCM encrypted user access_token
  webhook_secret      text NOT NULL,           -- AES-256-GCM encrypted HMAC signing secret
  inbox_id            integer,                 -- bound WhatsApp inbox (routing key)
  inbox_name          text,
  inbox_phone         text,                    -- display copy of the connected number
  status              text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'disconnected')),
  last_verified_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One connection per wacrm account (same UNIQUE discipline as
-- whatsapp_config.account_id).
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_connections_account_id_key
  ON chatwoot_connections (account_id);

-- Inbound webhook routing: payload.inbox.id → connection row.
CREATE INDEX IF NOT EXISTS chatwoot_connections_inbox_id_idx
  ON chatwoot_connections (inbox_id)
  WHERE inbox_id IS NOT NULL;

ALTER TABLE chatwoot_connections ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see connection state.
DROP POLICY IF EXISTS chatwoot_connections_select ON chatwoot_connections;
CREATE POLICY chatwoot_connections_select ON chatwoot_connections FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class).
DROP POLICY IF EXISTS chatwoot_connections_insert ON chatwoot_connections;
CREATE POLICY chatwoot_connections_insert ON chatwoot_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS chatwoot_connections_update ON chatwoot_connections;
CREATE POLICY chatwoot_connections_update ON chatwoot_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS chatwoot_connections_delete ON chatwoot_connections;
CREATE POLICY chatwoot_connections_delete ON chatwoot_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- conversations: cache the gateway-side conversation id.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS chatwoot_conversation_id integer;

CREATE INDEX IF NOT EXISTS conversations_chatwoot_conversation_id_idx
  ON conversations (chatwoot_conversation_id)
  WHERE chatwoot_conversation_id IS NOT NULL;

-- ============================================================
-- messages: per-row channel provenance.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'meta';

-- Guard the new column's values (matches the design comment above).
-- Written as a DO block so re-runs don't error on an existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_channel_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_channel_check
      CHECK (channel IN ('meta', 'chatwoot'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS messages_channel_idx
  ON messages (channel);

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PlugZap,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ChatwootNumberPairing } from '@/components/settings/chatwoot-number-pairing';

/**
 * Chatwoot gateway card — the unofficial WhatsApp channel (migration
 * 037). Rendered by the WhatsApp channel chooser in the settings tab;
 * the send core routes traffic through whichever channel has an
 * active connection (Chatwoot wins when present).
 *
 * Zero-credential UI: the gateway instance itself is configured by the
 * operator via CHATWOOT_* server env vars. Users see only the number
 * pairing flow:
 *   - env vars set → the gateway prepares itself automatically on
 *     first visit (verify + save + webhook registration), then the
 *     pairing wizard collects number (+ optional inbox name) and QR.
 *   - env vars missing → admins get setup instructions; there is no
 *     credential form to fill in the browser.
 * Credential rotation = update env vars, restart, remove gateway here,
 * pair again.
 */

interface ConnectionState {
  connected: boolean;
  gateway_configured?: boolean;
  id?: string;
  base_url?: string;
  inbox_name?: string | null;
  inbox_phone?: string | null;
  status?: string;
  webhook_url?: string;
}

export function ChatwootConfig() {
  const t = useTranslations('Settings.chatwoot');
  // Settings-class panel: owner AND admin may configure (same rule as
  // api-keys/deals settings). A strict isAdmin check would hide the
  // form from owners.
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [gatewayConfigured, setGatewayConfigured] = useState(false);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Outcome of the automatic webhook registration performed while
  // preparing — surfaced only when it needs manual attention.
  const [webhookOutcome, setWebhookOutcome] = useState<{
    registered: boolean;
    url: string;
    error: string | null;
  } | null>(null);

  // Auto-prepare must fire at most once per mount; the retry button
  // re-invokes prepareGateway directly.
  const prepareAttempted = useRef(false);

  const fetchConnection = useCallback(
    async (opts?: { silent?: boolean }) => {
      // Background refreshes must NOT flip the global loading gate:
      // that unmounts the pairing wizard mid-flow and destroys its
      // state — the exact bug that made QR pairing look dead while the
      // inbox was actually created just fine.
      const loud = opts?.silent !== true;
      if (loud) setLoading(true);
      try {
        const res = await fetch('/api/chatwoot/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ConnectionState;
        setGatewayConfigured(data.gateway_configured === true);
        setConnection(data.connected ? data : null);
      } catch (err) {
        console.error('[chatwoot-config] load failed:', err);
      } finally {
        if (loud) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void fetchConnection();
  }, [fetchConnection]);

  const prepareGateway = useCallback(async () => {
    setPreparing(true);
    setPrepareError(null);
    try {
      // No body: credentials come from the server's env vars. The
      // route verifies them against the instance before saving and
      // registers the inbound webhook.
      const res = await fetch('/api/chatwoot/config', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPrepareError(
          data?.detail || data?.error || `HTTP ${res.status}`
        );
        return;
      }
      setWebhookOutcome({
        registered: data.webhook_registered === true,
        url: data.webhook_url ?? '',
        error: data.webhook_error ?? null,
      });
      toast.success(t('saved'));
      await fetchConnection();
    } catch (err) {
      setPrepareError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  }, [fetchConnection, t]);

  useEffect(() => {
    if (
      loading ||
      preparing ||
      prepareError ||
      connection ||
      !canEditSettings ||
      !gatewayConfigured ||
      prepareAttempted.current
    ) {
      return;
    }
    prepareAttempted.current = true;
    void prepareGateway();
  }, [
    loading,
    preparing,
    prepareError,
    connection,
    canEditSettings,
    gatewayConfigured,
    prepareGateway,
  ]);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/chatwoot/config', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || `HTTP ${res.status}`);
        return;
      }
      setConnection(null);
      setWebhookOutcome(null);
      prepareAttempted.current = false;
      toast.success(t('disconnected'));
    } finally {
      setDisconnecting(false);
    }
  }

  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';
  const fullWebhookUrl =
    connection?.id && connection.webhook_url
      ? `${origin}${connection.webhook_url}`
      : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('loading')}
          </div>
        ) : !gatewayConfigured ? (
          canEditSettings ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>{t('gatewayMissingTitle')}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{t('gatewayMissingDesc')}</p>
                <div className="flex flex-col gap-1">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    CHATWOOT_BASE_URL
                  </code>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    CHATWOOT_ACCOUNT_ID
                  </code>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    CHATWOOT_ACCESS_TOKEN
                  </code>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('notConnectedDesc')}
            </p>
          )
        ) : connection ? (
          <>
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>{t('connectedTitle')}</AlertTitle>
              <AlertDescription className="space-y-1">
                <div>
                  {t('instance')}: {connection.base_url}
                </div>
                <div>
                  {t('boundInbox')}:{' '}
                  {connection.inbox_name
                    ? `${connection.inbox_name}${
                        connection.inbox_phone ? ` (${connection.inbox_phone})` : ''
                      }`
                    : t('noNumberYet')}
                </div>
              </AlertDescription>
            </Alert>

            {webhookOutcome && !webhookOutcome.registered ? (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertTitle>{t('webhookManualTitle')}</AlertTitle>
                <AlertDescription className="space-y-1">
                  <p>{t('webhookManualDesc')}</p>
                  <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">
                    {origin}/{webhookOutcome.url.replace(/^\//, '')}
                  </code>
                  {webhookOutcome.error ? (
                    <p className="text-xs opacity-80">{webhookOutcome.error}</p>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            {canEditSettings ? (
              <>
                <ChatwootNumberPairing
                  boundPhone={connection.inbox_phone ?? null}
                  onChanged={() => fetchConnection({ silent: true })}
                />
                <p className="text-xs text-muted-foreground">
                  {t('channelRule')}
                </p>

                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    {t('advanced')}
                  </summary>
                  <div className="mt-3 space-y-3">
                    {fullWebhookUrl ? (
                      <div>
                        <span className="font-medium">
                          {t('webhookUrlLabel')}:
                        </span>{' '}
                        <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">
                          {fullWebhookUrl}
                        </code>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('webhookAutoDesc')}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <Button
                        variant="destructive"
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                      >
                        {disconnecting ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                        {t('disconnect')}
                      </Button>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('rotateHint')}
                      </p>
                    </div>
                  </div>
                </details>
              </>
            ) : null}
          </>
        ) : canEditSettings ? (
          preparing ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />{' '}
              {t('preparingGateway')}
            </div>
          ) : prepareError ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>{t('prepareFailed')}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p className="break-all">{prepareError}</p>
                <Button size="sm" variant="outline" onClick={prepareGateway}>
                  <RefreshCw className="size-4" />
                  {t('retry')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('notConnectedDesc')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

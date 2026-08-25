'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  QrCode,
  RefreshCw,
  Smartphone,
  Unplug,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';

/**
 * WhatsApp number pairing wizard for the Chatwoot/Baileys channel
 * (migration 037). Rendered by ChatwootConfig once a gateway is
 * connected — this is the piece that brings QR pairing INTO the CRM
 * so users never need to open the Chatwoot dashboard.
 *
 * Flow: E.164 input → POST /api/chatwoot/whatsapp/connect (creates/
 * reuses the baileys inbox and starts the session) → poll
 * /api/chatwoot/whatsapp/status every 3s rendering the qr_data_url
 * until connection flips to 'open'. Re-invoking connect with the same
 * number regenerates an expired QR; disconnect logs the session out
 * while keeping the gateway configured.
 */

interface StatusResponse {
  pairing?: 'none' | 'pending' | 'open';
  connection_state?: string | null;
  qr_data_url?: string | null;
  error?: string | null;
}

type Phase = 'idle' | 'starting' | 'pairing' | 'open';

export function ChatwootNumberPairing({
  boundPhone,
  onChanged,
}: {
  /** Display copy of the currently bound number, if any. */
  boundPhone: string | null;
  /** Parent hook refresh (connection row may gain inbox_* fields). */
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('Settings.chatwoot');

  const [phase, setPhase] = useState<Phase>('idle');
  // Always start empty: the bound number shows up as an info line
  // below, and typing ANY number (same or different) is valid — a
  // different one switches the binding automatically.
  const [phone, setPhone] = useState('');
  const [inboxName, setInboxName] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Elapsed pairing time — drives the "QR is slow to arrive" hint so a
  // misconfigured Baileys backend doesn't leave an eternal spinner.
  const [waitingMs, setWaitingMs] = useState(0);

  // Keep the latest onChanged without re-triggering the polling effect.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const applyStatus = useCallback((data: StatusResponse): boolean => {
    if (data.pairing === 'open') {
      setPhase('open');
      setQrDataUrl(null);
      setStatusError(null);
      return true;
    }
    if (data.pairing === 'pending') {
      setQrDataUrl(data.qr_data_url ?? null);
      setStatusError(data.error ?? null);
    }
    return false;
  }, []);

  // On mount: if the bound number is already paired, jump straight to
  // the connected view instead of asking for a fresh QR.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/chatwoot/whatsapp/status');
        if (!res.ok) return;
        const data = (await res.json()) as StatusResponse;
        if (!cancelled && data.pairing === 'open') applyStatus(data);
      } catch {
        // Status probe is cosmetic on mount — pairing UI stays usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyStatus]);

  // Elapsed-time ticker for the pairing phase (reset elsewhere).
  useEffect(() => {
    if (phase !== 'pairing') {
      setWaitingMs(0);
      return;
    }
    const t0 = Date.now();
    const timer = setInterval(() => setWaitingMs(Date.now() - t0), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Poll while a pairing is in flight. The QR rotates server-side; we
  // just re-render whatever provider_connection currently holds and
  // stop the moment connection flips to 'open'.
  useEffect(() => {
    if (phase !== 'pairing') return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch('/api/chatwoot/whatsapp/status');
        const data = (await res.json()) as StatusResponse;
        if (cancelled) return;
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (applyStatus(data)) {
          onChangedRef.current();
          toast.success(t('paired'));
        }
      } catch (err) {
        if (!cancelled) {
          setStatusError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void tick();
    const timer = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, applyStatus, t]);

  async function handleStart() {
    if (!phone.trim()) {
      toast.error(t('phoneRequired'));
      return;
    }
    setPhase('starting');
    setStatusError(null);
    try {
      const res = await fetch('/api/chatwoot/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: phone.trim(),
          inbox_name: inboxName.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error || `HTTP ${res.status}`);
        setPhase(qrDataUrl ? 'pairing' : 'idle');
        return;
      }
      setPhase('pairing');
      void onChangedRef.current();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  }

  async function handleDisconnectNumber() {
    try {
      const res = await fetch('/api/chatwoot/whatsapp/disconnect', {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || `HTTP ${res.status}`);
        return;
      }
      setPhase('idle');
      setQrDataUrl(null);
      setStatusError(null);
      toast.success(t('numberDisconnected'));
      void onChangedRef.current();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Smartphone className="size-4" />
          {t('pairTitle')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('pairDesc')}</p>
      </div>

      {phase === 'open' ? (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertTitle>{t('paired')}</AlertTitle>
          <AlertDescription className="space-y-1">
            <div>{t('pairedDesc')}</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={handleDisconnectNumber}
            >
              <Unplug className="size-4" />
              {t('disconnectNumber')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label htmlFor="chatwoot-pair-phone">{t('phoneLabel')}</Label>
              <Input
                id="chatwoot-pair-phone"
                inputMode="tel"
                placeholder="+5511999999999"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="off"
              />
              {boundPhone ? (
                <p className="text-xs text-muted-foreground">
                  {t('currentNumber', { phone: boundPhone })}
                </p>
              ) : null}
            </div>
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label htmlFor="chatwoot-inbox-name">
                {t('inboxNameLabel')}
              </Label>
              <Input
                id="chatwoot-inbox-name"
                placeholder={t('inboxNamePlaceholder')}
                value={inboxName}
                onChange={(e) => setInboxName(e.target.value)}
                autoComplete="off"
              />
            </div>
            <Button
              type="button"
              onClick={handleStart}
              disabled={phase === 'starting'}
            >
              {phase === 'starting' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : phase === 'pairing' ? (
                <RefreshCw className="size-4" />
              ) : (
                <QrCode className="size-4" />
              )}
              {phase === 'pairing' ? t('regenerateQr') : t('generateQr')}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">{t('pairAnyHint')}</p>

          {statusError ? (
            <Alert variant="destructive">
              <AlertTitle>{t('pairProblemTitle')}</AlertTitle>
              <AlertDescription className="break-all">
                {statusError}
              </AlertDescription>
            </Alert>
          ) : null}

          {phase === 'pairing' && !qrDataUrl && waitingMs >= 15000 ? (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>{t('qrSlowTitle')}</AlertTitle>
              <AlertDescription>{t('qrSlowDesc')}</AlertDescription>
            </Alert>
          ) : null}

          {phase === 'pairing' ? (
            qrDataUrl ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border bg-muted/40 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL served inline by the QR itself */}
                <img
                  src={qrDataUrl}
                  alt={t('qrAlt')}
                  className="size-56 rounded bg-white p-2"
                />
                <p className="text-sm text-muted-foreground">{t('scanDesc')}</p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t('waitingScan')}
                </p>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('qrPending')}
              </p>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, QrCode } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { ChatwootConfig } from '@/components/settings/chatwoot-config';
import { cn } from '@/lib/utils';

/**
 * Channel chooser for the WhatsApp settings tab. The send core routes
 * ALL outbound through ONE active channel per account (Chatwoot when a
 * gateway connection exists, Meta otherwise) — this picker just makes
 * that choice visible up front instead of stacking both config cards
 * and letting the unofficial one drown at the bottom.
 *
 * Default selection mirrors reality: unofficial when a Chatwoot
 * connection is live (that IS the active channel), otherwise official.
 */

type Channel = 'official' | 'unofficial';

interface OptionCardProps {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  children?: React.ReactNode;
}

export function WhatsAppChannelPanel() {
  const t = useTranslations('Settings.whatsappChannel');
  const [channel, setChannel] = useState<Channel>('official');
  // One-shot probe so the picker opens on whichever channel is actually
  // live; ChatwootConfig re-fetches for its own detail view.
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/chatwoot/config');
        if (!res.ok) return;
        const data = (await res.json()) as { connected?: boolean };
        if (!cancelled && data.connected) setChannel('unofficial');
      } catch {
        // Probe failure leaves the official default — harmless.
      } finally {
        if (!cancelled) setProbed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <OptionCard
          selected={channel === 'official'}
          title={t('officialTitle')}
          description={t('officialDesc')}
          onSelect={() => setChannel('official')}
        >
          <BadgeCheck className="size-5" />
        </OptionCard>
        <OptionCard
          selected={channel === 'unofficial'}
          title={t('unofficialTitle')}
          description={t('unofficialDesc')}
          onSelect={() => setChannel('unofficial')}
        >
          <QrCode className="size-5" />
        </OptionCard>
      </div>

      {/* Keyed remount so switching tabs resets each form's local state
          cleanly instead of two mounted forms fighting over focus. */}
      {probed && channel === 'official' ? (
        <WhatsAppConfig key="official" />
      ) : null}
      {probed && channel === 'unofficial' ? (
        <ChatwootConfig key="unofficial" />
      ) : null}
    </div>
  );
}

function OptionCard({
  selected,
  title,
  description,
  onSelect,
  children,
}: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'rounded-xl border p-4 text-left transition-colors',
        'hover:bg-muted/50',
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border'
      )}
    >
      <span className="flex items-center gap-2">
        {children}
        <span className="font-medium">{title}</span>
      </span>
      <span className="mt-1 block text-sm text-muted-foreground">
        {description}
      </span>
    </button>
  );
}

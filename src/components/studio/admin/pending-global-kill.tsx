'use client';

import { useState, type ReactNode } from 'react';
import { Hourglass } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { ReasonDialog } from './reason-dialog';
import type { PendingGlobalKill } from './types';

// BACKLOG 15.D6 / spec 19.2 — "trigger global generation kill with two-person approval". A
// global kill request waits here until a DIFFERENT staff member confirms it (the API refuses the
// requester) or anyone withdraws it. Requests expire after 10 minutes.

export function minutesLeft(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

export function PendingGlobalKillBanner({
  pending,
  confirmPhrase,
  onConfirm,
  onWithdraw,
}: {
  pending: PendingGlobalKill;
  confirmPhrase: string;
  onConfirm: (reason: string) => Promise<boolean>;
  onWithdraw: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const left = minutesLeft(pending.expiresAt);
  const t = useTranslations('admin.killSwitch.pending');
  const f = useFormat();
  const who = (chunks: ReactNode) => <span className="font-mono text-foreground">{chunks}</span>;

  return (
    <section
      aria-labelledby="pending-global-kill"
      className="grid gap-3 rounded-2xl border border-warning/40 bg-warning-soft p-5"
    >
      <div className="flex items-start gap-3">
        <Hourglass className="mt-1 size-5 shrink-0 text-warning-foreground" />
        <div className="min-w-0">
          <h2 id="pending-global-kill" className="font-display text-xl leading-tight">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {pending.requestedByYou
              ? t.rich('requestedByYou', { who, at: f.date(pending.requestedAt), minutes: left })
              : t.rich('requestedBy', {
                  who,
                  name: pending.requestedBy,
                  at: f.date(pending.requestedAt),
                  minutes: left,
                })}
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">{t('reasonLabel')}</span> {pending.reason}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="destructive"
          disabled={pending.requestedByYou}
          onClick={() => setOpen(true)}
        >
          {t('confirm')}
        </Button>
        <Button
          variant="outline"
          disabled={withdrawing}
          onClick={async () => {
            setWithdrawing(true);
            await onWithdraw();
            setWithdrawing(false);
          }}
        >
          {t('withdraw')}
        </Button>
        {pending.requestedByYou && (
          <p className="text-sm text-muted-foreground">{t('ownRequest')}</p>
        )}
      </div>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title={t('dialogTitle')}
        description={t('dialogDescription', { name: pending.requestedBy })}
        confirmLabel={t('dialogConfirm')}
        confirmPhrase={confirmPhrase}
        destructive
        onConfirm={onConfirm}
      />
    </section>
  );
}

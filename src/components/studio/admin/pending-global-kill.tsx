'use client';

import { useState } from 'react';
import { Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/client/format';
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

  return (
    <section
      aria-labelledby="pending-global-kill"
      className="grid gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/8 p-5"
    >
      <div className="flex items-start gap-3">
        <Hourglass className="mt-1 size-5 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="min-w-0">
          <h2 id="pending-global-kill" className="font-display text-xl leading-tight">
            Global kill waiting for a second approver
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Requested by{' '}
            <span className="font-mono text-foreground">
              {pending.requestedByYou ? 'you' : pending.requestedBy}
            </span>{' '}
            at {formatDate(pending.requestedAt)} — expires in {left} min.
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground">Reason: </span>
            {pending.reason}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="destructive"
          disabled={pending.requestedByYou}
          onClick={() => setOpen(true)}
        >
          Confirm and halt Studio
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
          Withdraw request
        </Button>
        {pending.requestedByYou && (
          <p className="text-sm text-muted-foreground">
            Another PostMind staff member must confirm your request.
          </p>
        )}
      </div>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Confirm the global kill?"
        description={`Second approval for ${pending.requestedBy}’s request. Every organisation’s Studio jobs stop at their next step.`}
        confirmLabel="Confirm and halt"
        confirmPhrase={confirmPhrase}
        destructive
        onConfirm={onConfirm}
      />
    </section>
  );
}

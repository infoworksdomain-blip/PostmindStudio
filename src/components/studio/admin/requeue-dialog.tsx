'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { selectClass } from '../library/library-filters';
import type { DeadLetterJob } from './dead-letter-panel';
import { MIN_REASON } from './reason-dialog';
import { PROVIDER_IDS } from './types';

// BACKLOG 15.D4 — "requeue-with-different-provider". Only generate-asset jobs can take a provider
// preference (the server 400s the rest, and refuses a provider that is not a candidate for the
// shot's treatment and plan). The preference reorders the router's candidates; it never adds one.

export function RequeueDialog({
  job,
  onOpenChange,
  onConfirm,
}: {
  job: DeadLetterJob | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (body: { providerId?: string; reason: string }) => Promise<boolean>;
}) {
  const [providerId, setProviderId] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const reasonOk = reason.trim().length >= MIN_REASON;

  const close = () => {
    setProviderId('');
    setReason('');
    onOpenChange(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reasonOk || pending) return;
    setPending(true);
    const done = await onConfirm({
      ...(providerId && { providerId }),
      reason: reason.trim(),
    });
    setPending(false);
    if (done) close();
  };

  return (
    <Dialog open={job !== null} onOpenChange={(open) => (open ? onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Requeue {job?.name}</DialogTitle>
            <DialogDescription>
              {job?.providerOverride
                ? 'Adds the job again with fresh attempts. If its project failed at the asset stage, the stage resumes under a new run (assets already paid for are kept).'
                : 'Adds the job again with fresh attempts and the same data.'}
            </DialogDescription>
          </DialogHeader>
          {job?.providerOverride && (
            <div className="grid gap-1.5">
              <Label htmlFor="requeue-provider">Prefer provider (optional)</Label>
              <select
                id="requeue-provider"
                className={selectClass}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">Keep the router’s order</option>
                {PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="requeue-reason">Reason (recorded in the audit log)</Label>
            <Textarea
              id="requeue-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!reasonOk || pending}>
              {pending && <Loader2 className="animate-spin" />}
              Requeue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

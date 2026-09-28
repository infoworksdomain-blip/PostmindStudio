'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('admin.dialogs');
  const tc = useTranslations('common.actions');
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
            <DialogTitle>{t('requeue.title', { name: job?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {job?.providerOverride ? t('requeue.descriptionProvider') : t('requeue.description')}
            </DialogDescription>
          </DialogHeader>
          {job?.providerOverride && (
            <div className="grid gap-1.5">
              <Label htmlFor="requeue-provider">{t('requeue.preferProvider')}</Label>
              <select
                id="requeue-provider"
                className={selectClass}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">{t('requeue.keepOrder')}</option>
                {PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="requeue-reason">{t('reasonLabel')}</Label>
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
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={!reasonOk || pending}>
              {pending && <Loader2 className="animate-spin" />}
              {t('requeue.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

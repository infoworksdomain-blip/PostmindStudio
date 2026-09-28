'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, useErrorMessage } from '@/lib/client/api';

// BACKLOG 13.11 (Addendum A6.7 / A11.2) — "I don't own this site": any plan. Studio deletes the
// images scraped from the site within 24 hours and stops rescanning it.
// POST /businesses/:id/domain-verification/dispute { reason, confirmNotOwner: true }.

export function DisputeOwnership({
  businessId,
  onDone,
}: {
  businessId: string;
  onDone: () => void;
}) {
  const t = useTranslations('business.dispute');
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api(`/businesses/${encodeURIComponent(businessId)}/domain-verification/dispute`, {
        method: 'POST',
        body: { reason: reason.trim(), confirmNotOwner: true },
      });
      toast.success(t('done'));
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="link" className="h-auto justify-start p-0 text-xs text-muted-foreground">
          {t('trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmed && reason.trim().length >= 3) void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="dispute-reason">{t('reason')}</Label>
            <Textarea
              id="dispute-reason"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
            />
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="dispute-confirm"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor="dispute-confirm" className="text-sm leading-snug font-normal">
              {t('confirm')}
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!confirmed || reason.trim().length < 3 || busy}
            >
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

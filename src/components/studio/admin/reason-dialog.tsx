'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// Confirmation for kill-switch changes: every change needs a reason (audited, min 3 chars per
// setKillSwitchInput) and the riskiest ones also need a typed phrase.

export const MIN_REASON = 3;

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmPhrase,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** When set, the operator must type this exactly before confirming. */
  confirmPhrase?: string;
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const t = useTranslations('admin.dialogs');
  const tc = useTranslations('common.actions');
  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;
  const reasonOk = reason.trim().length >= MIN_REASON;

  const reset = () => {
    setReason('');
    setTyped('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reasonOk || !phraseOk || pending) return;
    setPending(true);
    const done = await onConfirm(reason.trim());
    setPending(false);
    if (done) {
      reset();
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="kill-reason">{t('reasonLabel')}</Label>
            <Textarea
              id="kill-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
              rows={3}
            />
          </div>
          {confirmPhrase && (
            <div className="grid gap-1.5">
              <Label htmlFor="kill-confirm">
                {t.rich('typeToConfirm', {
                  phrase: confirmPhrase,
                  code: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
                })}
              </Label>
              <Input
                id="kill-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {tc('cancel')}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={!reasonOk || !phraseOk || pending}
            >
              {pending && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

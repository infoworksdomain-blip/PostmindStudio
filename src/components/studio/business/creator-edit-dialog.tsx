'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { creatorPath, useCreatorErrorMessage, type Creator } from '../creators/types';

// BACKLOG 22.3 — "Regenerate" (a new portrait, with optional changes) and "Rename" for one
// creator. Regenerating goes through the same image route and caps as creating; videos already
// made keep the portrait they used.

export type EditKind = 'regenerate' | 'rename';

export function CreatorEditDialog({
  kind,
  creator,
  businessId,
  onOpenChange,
  onSaved,
}: {
  kind: EditKind;
  creator: Creator;
  businessId: string;
  onOpenChange: (open: boolean) => void;
  onSaved: (creator: Creator) => void;
}) {
  const t = useTranslations(`business.creators.${kind}Dialog`);
  const creatorError = useCreatorErrorMessage();
  const [text, setText] = useState(kind === 'rename' ? creator.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = kind === 'rename' && !text.trim();

  async function submit() {
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const path = creatorPath(businessId, creator.id);
      const res =
        kind === 'rename'
          ? await api<{ creator: Creator }>(path, {
              method: 'PATCH',
              body: { name: text.trim() },
              idempotencyKey: newIdempotencyKey(),
            })
          : await api<{ creator: Creator }>(`${path}/regenerate`, {
              method: 'POST',
              body: text.trim() ? { instructions: text.trim() } : {},
              idempotencyKey: newIdempotencyKey(),
            });
      onSaved(res.creator);
      onOpenChange(false);
    } catch (err) {
      setError(creatorError(err));
    } finally {
      setBusy(false);
    }
  }

  const inputId = `creator-${kind}-${creator.id}`;
  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { name: creator.name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          id={`${inputId}-form`}
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor={inputId}>{t('label')}</Label>
          <Input
            id={inputId}
            maxLength={kind === 'rename' ? 60 : 300}
            placeholder={t('placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {error && (
            <p
              role="alert"
              className="mt-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={`${inputId}-form`} disabled={invalid || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import { api, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { fromLocalInput, toLocalInput } from './month';
import { useProjectName } from '@/lib/client/use-project-name';

// BACKLOG 13.9 (spec 14.3) — reschedule a scheduled publication: PATCH /publications/:id
// { scheduledFor }. Drag a post to another day on the month grid, or use the move dialog (the
// keyboard and phone alternative) to pick any date and time.

export const MIN_LEAD_MS = 60_000;
/** Drag payload type: a publication id. */
export const DRAG_TYPE = 'application/x-studio-publication';

export function canMove(publication: Publication): boolean {
  return publication.state === 'SCHEDULED' && publication.scheduledFor !== null;
}

export function useReschedule(onMoved: () => void) {
  const t = useTranslations('calendar.move');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<string | null>(null);
  const move = async (publication: Publication, to: Date): Promise<boolean> => {
    if (to.getTime() - Date.now() < MIN_LEAD_MS) {
      toast.error(t('tooSoon'));
      return false;
    }
    setPending(publication.id);
    try {
      await api(`/publications/${publication.id}`, {
        method: 'PATCH',
        body: { scheduledFor: to.toISOString() },
      });
      toast.success(t('moved', { date: f.date(to.toISOString()) }));
      onMoved();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(null);
    }
  };
  return { move, pending };
}

export function MoveToDialog({
  publication,
  onClose,
  onMove,
}: {
  publication: Publication | null;
  onClose: () => void;
  onMove: (publication: Publication, to: Date) => Promise<boolean>;
}) {
  // Mounted per publication (the caller keys it), so the input starts at the current time.
  const [value, setValue] = useState(() =>
    publication?.scheduledFor ? toLocalInput(publication.scheduledFor) : '',
  );
  const t = useTranslations('calendar.move');
  const [busy, setBusy] = useState(false);
  const projectName = useProjectName();
  const name = publication?.project ? projectName(publication.project.name) : t('thisVideo');
  const to = fromLocalInput(value);

  return (
    <Dialog
      open={publication !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!publication || !to) return;
            setBusy(true);
            const moved = await onMove(publication, to);
            setBusy(false);
            if (moved) onClose();
          }}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="move-to">{t('newTime')}</Label>
            <Input
              id="move-to"
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!to || busy}>
              {busy ? t('moving') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

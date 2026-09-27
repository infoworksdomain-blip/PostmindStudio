'use client';

import { useState } from 'react';
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
import { api, errorMessage } from '@/lib/client/api';
import type { Publication } from '@/lib/client/types';
import { fromLocalInput, toLocalInput } from './month';

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
  const [pending, setPending] = useState<string | null>(null);
  const move = async (publication: Publication, to: Date): Promise<boolean> => {
    if (to.getTime() - Date.now() < MIN_LEAD_MS) {
      toast.error('Pick a time at least a minute from now.');
      return false;
    }
    setPending(publication.id);
    try {
      await api(`/publications/${publication.id}`, {
        method: 'PATCH',
        body: { scheduledFor: to.toISOString() },
      });
      toast.success(
        `Moved to ${to.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
      );
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
  const [busy, setBusy] = useState(false);
  const name = publication?.project?.name ?? 'this video';
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
          <DialogTitle>Move “{name}”</DialogTitle>
          <DialogDescription>
            Pick a new date and time (your local time), from a minute to 180 days ahead.
          </DialogDescription>
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
            <Label htmlFor="move-to">New time</Label>
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
              Cancel
            </Button>
            <Button type="submit" disabled={!to || busy}>
              {busy ? 'Moving…' : 'Move'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

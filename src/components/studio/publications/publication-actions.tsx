'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Ban, ExternalLink, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage, newIdempotencyKey } from '@/lib/client/api';
import { PLATFORM_LABEL, safeHttpUrl } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { ConfirmDialog } from './confirm-dialog';

// Row actions for a publication (spec 8.4): cancel a scheduled post, retry a failed one, take
// down a live one. Cancel and take-down are irreversible, so both ask first.

type Action = 'cancel' | 'retry' | 'takedown';

const DONE: Record<Action, string> = {
  cancel: 'Scheduled post cancelled',
  retry: 'Retry queued',
  takedown: 'Post taken down',
};

export function availableActions(p: Publication): Action[] {
  if (p.state === 'SCHEDULED' && p.scheduledFor) return ['cancel'];
  if (p.state === 'FAILED') return ['retry'];
  if (p.state === 'PUBLISHED') return ['takedown'];
  return [];
}

export function PublicationActions({
  publication,
  onChanged,
}: {
  publication: Publication;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [running, setRunning] = useState<Action | null>(null);
  const platform = PLATFORM_LABEL[publication.platform] ?? publication.platform;
  const name = publication.project?.name ?? 'this video';

  async function run(action: Action): Promise<boolean> {
    setRunning(action);
    try {
      await api(`/publications/${publication.id}/${action}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(DONE[action]);
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setRunning(null);
    }
  }

  const actions = availableActions(publication);
  const platformUrl = safeHttpUrl(publication.platformUrl);
  return (
    <div className="flex items-center justify-end gap-1">
      {platformUrl && (
        <Button variant="ghost" size="icon-sm" asChild>
          <a
            href={platformUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${name} on ${platform}`}
          >
            <ExternalLink />
          </a>
        </Button>
      )}
      {actions.includes('retry') && (
        <Button
          variant="outline"
          size="sm"
          disabled={running !== null}
          onClick={() => void run('retry')}
        >
          {running === 'retry' ? <Loader2 className="animate-spin" /> : <RotateCw />}
          <span className="sr-only sm:not-sr-only">Retry</span>
        </Button>
      )}
      {actions.includes('cancel') && (
        <Button variant="ghost" size="sm" onClick={() => setConfirming('cancel')}>
          <Ban />
          <span className="sr-only sm:not-sr-only">Cancel</span>
        </Button>
      )}
      {actions.includes('takedown') && (
        <Button variant="ghost" size="sm" onClick={() => setConfirming('takedown')}>
          <Trash2 />
          <span className="sr-only sm:not-sr-only">Take down</span>
        </Button>
      )}
      <ConfirmDialog
        open={confirming === 'cancel'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="Cancel this scheduled post?"
        description={`${name} will not be posted to ${platform}. You can schedule it again from the project.`}
        confirmLabel="Cancel post"
        onConfirm={() => run('cancel')}
      />
      <ConfirmDialog
        open={confirming === 'takedown'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Take this post down from ${platform}?`}
        description={`${name} will be deleted from ${platform} where its API allows. Views, likes and comments on the post are lost and this cannot be undone.`}
        confirmLabel="Take down"
        onConfirm={() => run('takedown')}
      />
    </div>
  );
}

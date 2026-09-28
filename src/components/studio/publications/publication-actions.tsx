'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Ban, ExternalLink, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { ConfirmDialog } from './confirm-dialog';

// Row actions for a publication (spec 8.4): cancel a scheduled post, retry a failed one, take
// down a live one. Cancel and take-down are irreversible, so both ask first.

type Action = 'cancel' | 'retry' | 'takedown';

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
  const t = useTranslations('publications.actions');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [running, setRunning] = useState<Action | null>(null);
  const platform = f.platform(publication.platform);
  const name = publication.project?.name ?? t('thisVideo');

  async function run(action: Action): Promise<boolean> {
    setRunning(action);
    try {
      await api(`/publications/${publication.id}/${action}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t(`done.${action}`));
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
            aria-label={t('openOn', { name, platform })}
          >
            <ExternalLink className="rtl:-scale-x-100" />
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
          <span className="sr-only sm:not-sr-only">{t('retry')}</span>
        </Button>
      )}
      {actions.includes('cancel') && (
        <Button variant="ghost" size="sm" onClick={() => setConfirming('cancel')}>
          <Ban />
          <span className="sr-only sm:not-sr-only">{t('cancel')}</span>
        </Button>
      )}
      {actions.includes('takedown') && (
        <Button variant="ghost" size="sm" onClick={() => setConfirming('takedown')}>
          <Trash2 />
          <span className="sr-only sm:not-sr-only">{t('takeDown')}</span>
        </Button>
      )}
      <ConfirmDialog
        open={confirming === 'cancel'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('cancelConfirm.title')}
        description={t('cancelConfirm.body', { name, platform })}
        confirmLabel={t('cancelConfirm.confirm')}
        onConfirm={() => run('cancel')}
      />
      <ConfirmDialog
        open={confirming === 'takedown'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('takedownConfirm.title', { platform })}
        description={t('takedownConfirm.body', { name, platform })}
        confirmLabel={t('takedownConfirm.confirm')}
        onConfirm={() => run('takedown')}
      />
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CalendarClock, Check, ExternalLink, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Publication } from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { useAction } from '../review/use-action';
import { GENERATABLE } from '../review/types';
import { useCan } from '../use-can';
import { canMove } from './reschedule';

// 24.2 — the side panel's actions, all existing routes: approve (POST /projects/:id/approve, as
// the Review screen's approval bar), reschedule (the calendar's own move dialog → PATCH
// /publications/:id), regenerate (POST /projects/:id/generate, as Review's "Generate again") and
// open the full project. Each shows only when the post's state and the member's role allow it.

export interface PostPanelActionsProps {
  projectId: string;
  state: string;
  publication: Publication | null;
  onReschedule: (publication: Publication) => void;
  onChanged: () => void;
}

export function PostPanelActions({
  projectId,
  state,
  publication,
  onReschedule,
  onChanged,
}: PostPanelActionsProps) {
  const t = useTranslations('calendar.panel.actions');
  const { pending, run, busy } = useAction();
  const mayApprove = useCan(StudioCapability.ProjectApprove);
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const mayPublish = useCan(StudioCapability.PublicationWrite);
  const canApprove = mayApprove && state === 'READY_FOR_REVIEW';
  const canRegenerate = mayWrite && GENERATABLE.has(state) && state !== 'DRAFT';
  const movable = mayPublish && publication !== null && canMove(publication);

  async function approve() {
    const ok = await run('approve', `/projects/${projectId}/approve`, {
      body: {},
      success: t('approved'),
    });
    if (ok) onChanged();
  }

  async function regenerate() {
    const ok = await run('regenerate', `/projects/${projectId}/generate`, {
      body: {},
      success: t('regenerating'),
    });
    if (ok) onChanged();
  }

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('aria')}>
      {canApprove && (
        <Button onClick={approve} disabled={busy}>
          {pending === 'approve' ? <Loader2 className="animate-spin" /> : <Check />}
          {t('approve')}
        </Button>
      )}
      {movable && publication && (
        <Button variant="outline" onClick={() => onReschedule(publication)} disabled={busy}>
          <CalendarClock /> {t('reschedule')}
        </Button>
      )}
      {canRegenerate && (
        <Button variant="outline" onClick={regenerate} disabled={busy}>
          {pending === 'regenerate' ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {t('regenerate')}
        </Button>
      )}
      <Button variant="ghost" asChild>
        <Link href={`/projects/${projectId}`}>
          <ExternalLink className="rtl:-scale-x-100" /> {t('open')}
        </Link>
      </Button>
    </div>
  );
}

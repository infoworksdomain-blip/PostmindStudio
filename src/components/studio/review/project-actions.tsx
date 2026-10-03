'use client';

import { useTranslations } from 'next-intl';
import { ACCOUNT_BANNER_ID } from '../account/account-banners';
import { useCreateBlock } from '../account/create-access';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Play, RotateCw, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useFormat } from '@/lib/client/format';
import { StudioCapability } from '@/lib/rbac';
import { useCan } from '../use-can';
import type { ProjectDetail } from '@/lib/client/types';
import { CANCELLABLE, GENERATABLE } from './types';
import { useAction } from './use-action';

// Header actions (generate / cancel) and the approve-or-reject bar of the Review screen.

export function ProjectActions({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.actions');
  const f = useFormat();
  const { pending, run, busy } = useAction();
  const { id, state } = project;
  // Generate and Cancel need studio:project:write; a viewer only reads.
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const block = useCreateBlock();
  if (!mayWrite) return null;

  async function generate() {
    const ok = await run('generate', `/projects/${id}/generate`, {
      body: {},
      success: t('started'),
    });
    if (ok) onChanged();
  }

  async function cancel() {
    const result = await run<{ costIncurredPence: number }>('cancel', `/projects/${id}/cancel`);
    if (result) {
      onChanged();
      toast.success(t('cancelled', { amount: f.pence(result.costIncurredPence) }));
    }
  }

  return (
    <>
      {CANCELLABLE.has(state) && (
        <Button variant="outline" onClick={cancel} disabled={busy}>
          {pending === 'cancel' ? <Loader2 className="animate-spin" /> : <Square />} {t('cancel')}
        </Button>
      )}
      {GENERATABLE.has(state) && state !== 'READY_FOR_REVIEW' && (
        <Button
          onClick={generate}
          disabled={busy || block === 'read_only'}
          aria-describedby={block ? ACCOUNT_BANNER_ID : undefined}
        >
          {pending === 'generate' ? (
            <Loader2 className="animate-spin" />
          ) : state === 'DRAFT' ? (
            <Play />
          ) : (
            <RotateCw />
          )}
          {state === 'DRAFT' ? t('generate') : t('generateAgain')}
        </Button>
      )}
    </>
  );
}

export function ApprovalBar({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.approval');
  const { pending, run, busy } = useAction();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const canApprove = project.state === 'READY_FOR_REVIEW';
  const canReject = canApprove || project.state === 'QUALITY_FAILED';
  // The API answers 403 to anyone without studio:project:approve: say so instead of offering buttons.
  const mayDecide = useCan(StudioCapability.ProjectApprove);
  if (!canReject) return null;
  if (!mayDecide)
    return (
      <section
        aria-label={t('aria')}
        className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
      >
        {t('noPermission')}
      </section>
    );

  /** Closes the note form (Back or Escape) and returns focus to the button that opened it. */
  function close() {
    const opener = mode === 'reject' ? rejectRef : approveRef;
    setMode(null);
    requestAnimationFrame(() => opener.current?.focus());
  }

  async function submit() {
    if (!mode) return;
    const trimmed = note.trim();
    const ok = await run(mode, `/projects/${project.id}/${mode}`, {
      body: mode === 'reject' ? { note: trimmed } : trimmed ? { note: trimmed } : {},
      success: mode === 'approve' ? t('approved') : t('rejected'),
    });
    if (ok) {
      setMode(null);
      setNote('');
      onChanged();
    }
  }

  return (
    <section
      aria-label={t('aria')}
      className="flex flex-col gap-3 rounded-xl border border-foreground/15 bg-card p-4"
      // Escape anywhere in the bar (the note, Back, or the Approve/Reject button that opened it,
      // which keeps focus) closes the note form; not while the decision is saving.
      onKeyDown={(e) => {
        if (e.key === 'Escape' && mode && !busy) {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">{canApprove ? t('readyPrompt') : t('qualityFailedPrompt')}</p>
        <div className="flex gap-2">
          {canApprove && (
            <Button
              ref={approveRef}
              onClick={() => setMode('approve')}
              aria-pressed={mode === 'approve'}
              disabled={busy}
            >
              <Check /> {t('approve')}
            </Button>
          )}
          <Button
            ref={rejectRef}
            variant="destructive"
            onClick={() => setMode('reject')}
            aria-pressed={mode === 'reject'}
            disabled={busy}
          >
            <X /> {t('reject')}
          </Button>
        </div>
      </div>
      {mode && (
        <div className="flex flex-col gap-2">
          <label htmlFor="approval-note" className="text-xs font-medium text-muted-foreground">
            {mode === 'reject' ? t('rejectNote') : t('approveNote')}
          </label>
          <Textarea
            id="approval-note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('back')}
            </Button>
            <Button
              variant={mode === 'reject' ? 'destructive' : 'default'}
              onClick={submit}
              disabled={busy || (mode === 'reject' && !note.trim())}
            >
              {pending && <Loader2 className="animate-spin" />}
              {mode === 'reject' ? t('confirmReject') : t('confirmApprove')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

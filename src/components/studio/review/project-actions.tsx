'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Play, RotateCw, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatPence } from '@/lib/client/format';
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
  const { pending, run, busy } = useAction();
  const { id, state } = project;

  async function generate() {
    const ok = await run('generate', `/projects/${id}/generate`, {
      body: {},
      success: 'Generation started.',
    });
    if (ok) onChanged();
  }

  async function cancel() {
    const result = await run<{ costIncurredPence: number }>('cancel', `/projects/${id}/cancel`);
    if (result) {
      onChanged();
      toast.success(`Cancelled — ${formatPence(result.costIncurredPence)} was spent on this run.`);
    }
  }

  return (
    <>
      {CANCELLABLE.has(state) && (
        <Button variant="outline" onClick={cancel} disabled={busy}>
          {pending === 'cancel' ? <Loader2 className="animate-spin" /> : <Square />} Cancel
        </Button>
      )}
      {GENERATABLE.has(state) && state !== 'READY_FOR_REVIEW' && (
        <Button onClick={generate} disabled={busy}>
          {pending === 'generate' ? (
            <Loader2 className="animate-spin" />
          ) : state === 'DRAFT' ? (
            <Play />
          ) : (
            <RotateCw />
          )}
          {state === 'DRAFT' ? 'Generate' : 'Generate again'}
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
  const { pending, run, busy } = useAction();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const canApprove = project.state === 'READY_FOR_REVIEW';
  const canReject = canApprove || project.state === 'QUALITY_FAILED';
  if (!canReject) return null;

  async function submit() {
    if (!mode) return;
    const trimmed = note.trim();
    const ok = await run(mode, `/projects/${project.id}/${mode}`, {
      body: mode === 'reject' ? { note: trimmed } : trimmed ? { note: trimmed } : {},
      success: mode === 'approve' ? 'Approved — ready to publish.' : 'Rejected.',
    });
    if (ok) {
      setMode(null);
      setNote('');
      onChanged();
    }
  }

  return (
    <section
      aria-label="Approval"
      className="flex flex-col gap-3 rounded-xl border border-foreground/15 bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {canApprove
            ? 'Watch each variant, then approve it for publishing or send it back.'
            : 'The quality check failed. Force-approve a variant below, or reject the project.'}
        </p>
        <div className="flex gap-2">
          {canApprove && (
            <Button
              onClick={() => setMode('approve')}
              aria-pressed={mode === 'approve'}
              disabled={busy}
            >
              <Check /> Approve
            </Button>
          )}
          <Button
            variant="destructive"
            onClick={() => setMode('reject')}
            aria-pressed={mode === 'reject'}
            disabled={busy}
          >
            <X /> Reject
          </Button>
        </div>
      </div>
      {mode && (
        <div className="flex flex-col gap-2">
          <label htmlFor="approval-note" className="text-xs font-medium text-muted-foreground">
            {mode === 'reject' ? 'What needs to change? (required)' : 'Note (optional)'}
          </label>
          <Textarea
            id="approval-note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode(null)} disabled={busy}>
              Back
            </Button>
            <Button
              variant={mode === 'reject' ? 'destructive' : 'default'}
              onClick={submit}
              disabled={busy || (mode === 'reject' && !note.trim())}
            >
              {pending && <Loader2 className="animate-spin" />}
              {mode === 'reject' ? 'Confirm rejection' : 'Confirm approval'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

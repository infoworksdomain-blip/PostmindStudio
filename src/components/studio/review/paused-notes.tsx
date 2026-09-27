'use client';

import { useState } from 'react';
import { PauseCircle, ShieldAlert } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import type { ProjectDetail } from '@/lib/client/types';
import { useAction } from './use-action';

// Review screen notes for runs that are paused rather than broken:
//   - 13.20: the organisation's daily / monthly generation budget paused the run; it resumes
//     automatically after the rollover (00:05 UTC; monthly on the 1st) unless turned off here
//     (PATCH /projects/:id { autoResume }).
//   - 13.17: the run waits for PostMind's content-safety review.

type Pause = { scope?: string; period?: string };

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function orgCapPause(
  project: Pick<ProjectDetail, 'state' | 'errorReason' | 'metadata'>,
): 'org_daily' | 'org_monthly' | null {
  if (project.state !== 'FAILED' || !(project.errorReason ?? '').startsWith('cost_cap_paused'))
    return null;
  const scope = (record(project.metadata?.costPause) as Pause | null)?.scope;
  return scope === 'org_daily' || scope === 'org_monthly' ? scope : null;
}

export function AutoResumeNote({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const [enabled, setEnabled] = useState(project.metadata?.autoResume !== false);
  const scope = orgCapPause(project);
  if (!scope) return null;

  const toggle = async (next: boolean) => {
    setEnabled(next);
    const ok = await run('auto-resume', `/projects/${project.id}`, {
      method: 'PATCH',
      body: { autoResume: next },
      success: next ? 'Will resume automatically' : 'Automatic resume turned off',
    });
    if (ok) onChanged();
    else setEnabled(!next);
  };

  return (
    <section
      aria-label="Paused by budget"
      className="flex flex-col gap-2 rounded-xl border border-foreground/15 bg-card p-4 text-sm"
    >
      <p className="flex items-start gap-2">
        <PauseCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        {scope === 'org_daily'
          ? 'Paused: your organisation’s generation budget for today is spent.'
          : 'Paused: your organisation’s generation budget for this month is spent.'}{' '}
        {enabled
          ? scope === 'org_daily'
            ? 'It resumes automatically at 00:05 UTC.'
            : 'It resumes automatically on the 1st at 00:05 UTC.'
          : 'Automatic resume is off — press “Generate again” when you are ready.'}
      </p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(v) => void toggle(v)}
          aria-label="Resume automatically"
        />
        Resume automatically
      </label>
    </section>
  );
}

export function SafetyReviewNote({ project }: { project: ProjectDetail }) {
  const marker = record(project.metadata?.safetyReview);
  if (marker?.state !== 'PENDING') return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
      Paused for a content-safety review by PostMind’s Trust &amp; Safety team. Generation continues
      automatically if it is allowed; you will be notified either way.
    </p>
  );
}

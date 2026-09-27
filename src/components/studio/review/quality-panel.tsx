'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { QualityIssue, Render } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { useAction } from './use-action';

// Spec 14.2 quality-check panel: passed items ticked, failures red with click-to-see detail,
// and a force-approve override for failed renders (spec 13.5; audited, capability-gated).

const STATUS = {
  passed: { icon: CheckCircle2, className: 'text-success', label: 'Passed' },
  failed: { icon: XCircle, className: 'text-destructive', label: 'Failed' },
  warning: { icon: AlertTriangle, className: 'text-warning', label: 'Warning' },
  skipped: { icon: CircleSlash, className: 'text-muted-foreground', label: 'Skipped' },
} as const;

const ORDER: Record<QualityIssue['status'], number> = {
  failed: 0,
  warning: 1,
  passed: 2,
  skipped: 3,
};

export function humanCode(code: string): string {
  const text = code.replace(/[_.]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function QualityPanel({ render, onChanged }: { render: Render; onChanged: () => void }) {
  const issues = [...(render.qualityIssues ?? [])].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status],
  );
  const { pending, run } = useAction();
  const [note, setNote] = useState('');

  async function forceApprove() {
    const ok = await run('force', `/renders/${render.id}/force-approve`, {
      body: { note: note.trim() },
      success: 'Quality check overridden.',
    });
    if (ok) {
      setNote('');
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Quality check
      </h3>
      {render.qualityCheckState === 'PENDING' && (
        <p className="text-sm text-muted-foreground">Checks are still running.</p>
      )}
      {issues.length === 0 && render.qualityCheckState !== 'PENDING' && (
        <p className="text-sm text-muted-foreground">No individual checks were reported.</p>
      )}
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((issue, i) => {
            const s = STATUS[issue.status] ?? STATUS.skipped;
            const Icon = s.icon;
            return (
              <li key={`${issue.code}-${i}`}>
                <details className="group rounded-md px-1 py-1 open:bg-muted/40">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    <Icon className={cn('size-4 shrink-0', s.className)} aria-hidden />
                    <span className="sr-only">{s.label}: </span>
                    <span className="min-w-0 flex-1 truncate">{humanCode(issue.code)}</span>
                    <span className="text-xs text-muted-foreground">{issue.severity}</span>
                  </summary>
                  <p className="mt-1 pl-6 text-xs text-muted-foreground">{issue.detail}</p>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {render.qualityCheckState === 'FORCE_APPROVED' && (
        <p className="text-xs text-muted-foreground">Failures were overridden by a reviewer.</p>
      )}
      {render.qualityCheckState === 'FAILED' && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/25 p-3">
          <label htmlFor={`force-${render.id}`} className="text-xs font-medium">
            Override the failed check — reason (required, audited)
          </label>
          <div className="flex gap-2">
            <Input
              id={`force-${render.id}`}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={forceApprove}
              disabled={!note.trim() || pending !== null}
            >
              {pending === 'force' && <Loader2 className="animate-spin" />}
              Force-approve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

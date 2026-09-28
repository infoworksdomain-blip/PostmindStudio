'use client';

import { useTranslations } from 'next-intl';
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
  passed: { icon: CheckCircle2, className: 'text-success' },
  failed: { icon: XCircle, className: 'text-destructive' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
  skipped: { icon: CircleSlash, className: 'text-muted-foreground' },
} as const;

const CODES = [
  'content_safety',
  'duration_match',
  'black_frames',
  'audio_present',
  'aspect_ratio',
  'codec',
] as const;
const SEVERITIES = ['block', 'error', 'warning', 'info'] as const;
const oneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

const ORDER: Record<QualityIssue['status'], number> = {
  failed: 0,
  warning: 1,
  passed: 2,
  skipped: 3,
};

/** A readable label for a check code the catalogue does not know (future checks). */
export function humanCode(code: string): string {
  const text = code.replace(/[_.]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function QualityPanel({ render, onChanged }: { render: Render; onChanged: () => void }) {
  const issues = [...(render.qualityIssues ?? [])].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status],
  );
  const t = useTranslations('review.quality');
  const { pending, run } = useAction();
  const [note, setNote] = useState('');
  const codeLabel = (code: string) => (oneOf(CODES, code) ? t(`codes.${code}`) : humanCode(code));
  const severityLabel = (s: string) => (oneOf(SEVERITIES, s) ? t(`severity.${s}`) : s);

  async function forceApprove() {
    const ok = await run('force', `/renders/${render.id}/force-approve`, {
      body: { note: note.trim() },
      success: t('overridden'),
    });
    if (ok) {
      setNote('');
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('title')}
      </h3>
      {render.qualityCheckState === 'PENDING' && (
        <p className="text-sm text-muted-foreground">{t('pending')}</p>
      )}
      {issues.length === 0 && render.qualityCheckState !== 'PENDING' && (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      )}
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((issue, i) => {
            const status = issue.status in STATUS ? issue.status : 'skipped';
            const s = STATUS[status];
            const Icon = s.icon;
            return (
              <li key={`${issue.code}-${i}`}>
                <details className="group rounded-md px-1 py-1 open:bg-muted/40">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    <Icon className={cn('size-4 shrink-0', s.className)} aria-hidden />
                    <span className="sr-only">
                      {t('statusLabel', { status: t(`status.${status}`) })}{' '}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{codeLabel(issue.code)}</span>
                    <span className="text-xs text-muted-foreground">
                      {severityLabel(issue.severity)}
                    </span>
                  </summary>
                  <p className="mt-1 ps-6 text-xs text-muted-foreground">{issue.detail}</p>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {render.qualityCheckState === 'FORCE_APPROVED' && (
        <p className="text-xs text-muted-foreground">{t('forceApproved')}</p>
      )}
      {render.qualityCheckState === 'FAILED' && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/25 p-3">
          <label htmlFor={`force-${render.id}`} className="text-xs font-medium">
            {t('overrideLabel')}
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
              {t('forceApprove')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

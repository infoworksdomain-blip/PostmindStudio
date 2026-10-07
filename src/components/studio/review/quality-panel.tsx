'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { QualityIssue, Render } from '@/lib/client/types';
import { useFormat } from '@/lib/client/format';
import { StudioCapability } from '@/lib/rbac';
import { cn } from '@/lib/utils';
import { useCan } from '../use-can';
import { humanCode, useIsStaff, useQualityCheckLabel } from '../failure-reason';
import { useAction } from './use-action';

export { humanCode };

// Spec 14.2 quality-check panel: passed items ticked, failures red with click-to-see detail,
// and a force-approve override for failed renders (spec 13.5; audited, capability-gated).

const STATUS = {
  passed: { icon: CheckCircle2, className: 'text-success' },
  failed: { icon: XCircle, className: 'text-destructive' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
  skipped: { icon: CircleSlash, className: 'text-muted-foreground' },
} as const;

/** 17.9: detail keys the catalogue knows (review.quality.details.<key>). */
export const DETAIL_KEYS = [
  'safetyScanUnavailable',
  'safetyNotScanned',
  'safetyBlocked',
  'safetyReview',
  'safetyPassed',
  'duration',
  'blackFrames',
  'noBlackFrames',
  'noAudio',
  'loudness',
  'aspectRatio',
  'codec',
  'audioSyncNotBuilt',
  'watermarkNotBuilt',
  'captionSyncNotBuilt',
  'brandKitNotBuilt',
  'noTimelineSummary',
  'noNarration',
  'audioSyncFailed',
  'audioSyncPassed',
  'audioSyncShortened',
  'noSpokenCaptions',
  'captionSyncFailed',
  'captionSyncPassed',
  'kitHasNoWatermark',
  'slideshowNoWatermark',
  'watermarkNotCovering',
  'watermarkSampleUnavailable',
  'watermarkVisible',
  'watermarkNotVisible',
  'noBrandKit',
  'brandKitMissing',
  'brandKitPresent',
  'forceApproved',
  'allowedByReview',
  'clipTextBurnedIn',
] as const;
const SEVERITIES = ['block', 'error', 'warning', 'info'] as const;
const oneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * 20.21: a content-safety scan that did not run (no provider is configured) is an operator
 * matter; staff see a neutral "Not scanned", customers see nothing about it.
 */
export function isUnscannedSafety(issue: Pick<QualityIssue, 'code' | 'status'>): boolean {
  return issue.code === 'content_safety' && issue.status === 'not_run';
}

/** A failed check no customer may override (content-safety block, spec 13.5). */
export function isHardFailure(issues: Array<Pick<QualityIssue, 'status' | 'severity'>>): boolean {
  return issues.some((issue) => issue.status === 'failed' && issue.severity === 'block');
}

const ORDER: Record<QualityIssue['status'], number> = {
  failed: 0,
  warning: 1,
  passed: 2,
  skipped: 3,
  not_run: 3,
};

export function QualityPanel({ render, onChanged }: { render: Render; onChanged: () => void }) {
  const staff = useIsStaff();
  const issues = (render.qualityIssues ?? [])
    .filter((issue) => staff || !isUnscannedSafety(issue))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const t = useTranslations('review.quality');
  const { pending, run } = useAction();
  const [note, setNote] = useState('');
  const codeLabel = useQualityCheckLabel();
  const f = useFormat();
  const mayForceApprove = useCan(StudioCapability.RenderForceApprove);
  // 20.22: every failed check except a content-safety block is a soft (force-approvable) failure;
  // the server refuses to override a block (services/renders.ts), so no override is offered.
  const blocked = isHardFailure(render.qualityIssues ?? []);
  // 17.9: the detail in the reader's language when the check carries a key; numbers in the
  // locale's digits (counts stay numeric for plurals); otherwise the stored English detail.
  const detailText = (issue: QualityIssue) => {
    const key = issue.detailKey;
    if (!key || !oneOf(DETAIL_KEYS, key)) return issue.detail;
    const params = Object.fromEntries(
      Object.entries(issue.detailParams ?? {}).map(([name, value]) => [
        name,
        typeof value === 'number' && name !== 'count'
          ? f.number(value, { maximumFractionDigits: 2, useGrouping: false })
          : value,
      ]),
    );
    return t(`details.${key}`, params);
  };
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
            const status =
              issue.status === 'not_run' || !(issue.status in STATUS) ? 'skipped' : issue.status;
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
                  <p className="mt-1 ps-6 text-xs text-muted-foreground">{detailText(issue)}</p>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {render.qualityCheckState === 'FORCE_APPROVED' && (
        <p className="text-xs text-muted-foreground">{t('forceApproved')}</p>
      )}
      {render.qualityCheckState === 'FAILED' && blocked && (
        <p className="text-xs text-muted-foreground">{t('blockedNoOverride')}</p>
      )}
      {render.qualityCheckState === 'FAILED' && !blocked && !mayForceApprove && (
        <p className="text-xs text-muted-foreground">{t('askToOverride')}</p>
      )}
      {render.qualityCheckState === 'FAILED' && !blocked && mayForceApprove && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/25 p-3">
          <p className="text-xs text-muted-foreground">{t('softFailureHint')}</p>
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
              loading={pending === 'force'}
              variant="outline"
              onClick={forceApprove}
              disabled={!note.trim() || pending !== null}
            >
              {t('forceApprove')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { BadgeCheck, CircleAlert, Send, UserCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection, ProjectDetail } from '@/lib/client/types';
import {
  approvalOrigin,
  readAutoPublishResult,
  readReview,
  readTargets,
  type AutoPublishTarget,
  type AutoPublishTargetResult,
  type ReviewRecord,
} from '../automation/automation';
import { AutoPublishOutbox } from './auto-publish-outbox';
import { SaveTemplate } from './save-template';

// Review screen: how this project is approved and published automatically — "Approved
// automatically" vs by a person, why it still needs a person (spec 5.9), the auto-publish targets
// and what happened to each (spec 3 "auto-publish on approval"), and "Save as template".

function accountName(
  target: AutoPublishTarget,
  connections: PlatformConnection[] | undefined,
  fallback: string,
) {
  if (target.connectionId)
    return connections?.find((c) => c.id === target.connectionId)?.platformAccountName ?? fallback;
  const meta = target.platformAccountId
    ? connections?.find((c) => c.platformAccountId === target.platformAccountId)
    : undefined;
  return meta?.platformAccountName ?? fallback;
}

function ResultLine({ result }: { result: AutoPublishTargetResult | undefined }) {
  const t = useTranslations('review.automation');
  const f = useFormat();
  if (!result) return <span className="text-muted-foreground">{t('waits')}</span>;
  if (result.status === 'created')
    return (
      <span>
        {result.scheduledFor ? t('scheduledFor', { date: f.date(result.scheduledFor) }) : t('sent')}
      </span>
    );
  return (
    <span className="text-destructive">
      {t('notPublished', { error: result.error ?? t('failedFallback') })}
    </span>
  );
}

function Targets({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.automation');
  const f = useFormat();
  const targets = readTargets(project.metadata);
  const outcome = readAutoPublishResult(project.metadata);
  const connections = useApi<{ data: PlatformConnection[] }>(
    targets.some((t) => t.connectionId) ? '/platform-connections' : null,
  );
  if (targets.length === 0)
    return <p className="text-sm text-muted-foreground">{t('noTargets')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        <Send className="me-1.5 inline size-4 rtl:-scale-x-100" strokeWidth={1.5} />
        {outcome
          ? t('publishesAutomaticallyLastRun', { date: f.date(outcome.at) })
          : t('publishesAutomatically')}
      </p>
      {outcome?.error && <p className="text-sm text-destructive">{outcome.error}</p>}
      <ul className="flex flex-col gap-1 text-sm" aria-label={t('targetsAria')}>
        {targets.map((target, i) => (
          <li
            key={`${target.platform}-${target.connectionId ?? target.platformAccountId ?? i}`}
            className="flex flex-wrap justify-between gap-2 rounded-md border border-border/70 px-2.5 py-1.5"
          >
            <span>
              {f.platform(target.platform)} ·{' '}
              {accountName(target, connections.data?.data, t('accountFallback'))}
            </span>
            <ResultLine result={outcome?.results.find((r) => r.index === i)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const REVIEW_REASON_CODES = [
  'enterprise_plan',
  'org_policy',
  'config_invalid',
  'force_approved',
  'content_safety_flag',
  'quality_not_clean',
  'script_safety_flag',
  'not_trusted',
  'approval_workflow',
  'auto_approve_error',
] as const;

/**
 * 17.9: why a person must review, in the reader's language (review.automation.reasons.<code>);
 * the stored English reason for a code this build does not know.
 */
export function useReviewReason(): (review: ReviewRecord) => string {
  const t = useTranslations('review.automation');
  const f = useFormat();
  return (review: ReviewRecord) => {
    const fallback = review.reason ?? t('needsReview');
    const code = review.code ?? '';
    const params = review.params ?? {};
    const platform = typeof params.platform === 'string' ? f.platform(params.platform) : null;
    if (!(REVIEW_REASON_CODES as readonly string[]).includes(code)) return fallback;
    switch (code as (typeof REVIEW_REASON_CODES)[number]) {
      case 'force_approved':
        return platform ? t('reasons.force_approved', { platform }) : fallback;
      case 'content_safety_flag':
        return platform
          ? t('reasons.content_safety_flag', {
              platform,
              outcome: params.outcome === 'not_run' ? 'not_run' : 'flagged',
            })
          : fallback;
      case 'quality_not_clean':
        if (platform) return t('reasons.quality_not_clean', { platform });
        return review.params ? t('reasons.no_renders') : fallback;
      case 'not_trusted':
        if (!review.params) return fallback;
        return t('reasons.not_trusted', {
          approved: f.number(Number(params.approved ?? review.humanApprovedCount ?? 0)),
          needed: f.number(Number(params.needed ?? review.threshold ?? 0)),
        });
      case 'approval_workflow':
        return typeof params.workflow === 'string'
          ? t('reasons.approval_workflow', { workflow: params.workflow })
          : fallback;
      default:
        return t(`reasons.${code as 'enterprise_plan'}`);
    }
  };
}

export function AutomationPanel({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.automation');
  const origin = approvalOrigin(project.approvals);
  const review = readReview(project.metadata);
  const needsReview =
    project.state === 'READY_FOR_REVIEW' && review?.decision === 'needs_review' ? review : null;
  const reviewReason = useReviewReason();
  const autoPublish = project.publishPolicy === 'AUTO_ON_APPROVAL';
  const canSave = project.sourceType !== 'SLIDESHOW' && project.scripts.length > 0;
  if (!origin && !needsReview && !autoPublish && !canSave) return null;

  return (
    <section
      aria-label={t('aria')}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      {origin === 'automatic' && (
        <p className="flex items-center gap-2 text-sm">
          <BadgeCheck className="size-4 text-emerald-600" strokeWidth={1.5} />
          {t('approvedAutomatically')}
        </p>
      )}
      {origin === 'person' && (
        <p className="flex items-center gap-2 text-sm">
          <UserCheck className="size-4" strokeWidth={1.5} /> {t('approvedByPerson')}
        </p>
      )}
      {needsReview && (
        <p className="flex items-start gap-2 text-sm" role="status">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
          {reviewReason(needsReview)}
        </p>
      )}
      {autoPublish && <Targets project={project} />}
      {autoPublish && <AutoPublishOutbox projectId={project.id} />}
      {canSave && (
        <div>
          <SaveTemplate projectId={project.id} defaultName={project.name ?? ''} />
        </div>
      )}
    </section>
  );
}

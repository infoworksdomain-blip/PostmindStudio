'use client';

import { BadgeCheck, CircleAlert, Send, UserCheck } from 'lucide-react';
import { useApi } from '@/lib/client/api';
import { formatDate, PLATFORM_LABEL } from '@/lib/client/format';
import type { PlatformConnection, ProjectDetail } from '@/lib/client/types';
import {
  approvalOrigin,
  readAutoPublishResult,
  readReview,
  readTargets,
  type AutoPublishTarget,
  type AutoPublishTargetResult,
} from '../automation/automation';
import { AutoPublishOutbox } from './auto-publish-outbox';
import { SaveTemplate } from './save-template';

// Review screen: how this project is approved and published automatically — "Approved
// automatically" vs by a person, why it still needs a person (spec 5.9), the auto-publish targets
// and what happened to each (spec 3 "auto-publish on approval"), and "Save as template".

function accountName(target: AutoPublishTarget, connections: PlatformConnection[] | undefined) {
  if (target.connectionId)
    return connections?.find((c) => c.id === target.connectionId)?.platformAccountName ?? 'account';
  const meta = target.platformAccountId
    ? connections?.find((c) => c.platformAccountId === target.platformAccountId)
    : undefined;
  return meta?.platformAccountName ?? 'account';
}

function ResultLine({ result }: { result: AutoPublishTargetResult | undefined }) {
  if (!result) return <span className="text-muted-foreground">Waits for approval</span>;
  if (result.status === 'created')
    return (
      <span>
        {result.scheduledFor
          ? `Scheduled for ${formatDate(result.scheduledFor)}`
          : 'Sent to publish'}
      </span>
    );
  return <span className="text-destructive">Not published: {result.error ?? 'failed'}</span>;
}

function Targets({ project }: { project: ProjectDetail }) {
  const targets = readTargets(project.metadata);
  const outcome = readAutoPublishResult(project.metadata);
  const connections = useApi<{ data: PlatformConnection[] }>(
    targets.some((t) => t.connectionId) ? '/platform-connections' : null,
  );
  if (targets.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Auto-publish is on, but no accounts are chosen — nothing will be posted automatically.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        <Send className="mr-1.5 inline size-4" strokeWidth={1.5} />
        Publishes automatically when approved
        {outcome && ` · last run ${formatDate(outcome.at)}`}
      </p>
      {outcome?.error && <p className="text-sm text-destructive">{outcome.error}</p>}
      <ul className="flex flex-col gap-1 text-sm" aria-label="Auto-publish targets">
        {targets.map((t, i) => (
          <li
            key={`${t.platform}-${t.connectionId ?? t.platformAccountId ?? i}`}
            className="flex flex-wrap justify-between gap-2 rounded-md border border-border/70 px-2.5 py-1.5"
          >
            <span>
              {PLATFORM_LABEL[t.platform] ?? t.platform} · {accountName(t, connections.data?.data)}
            </span>
            <ResultLine result={outcome?.results.find((r) => r.index === i)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AutomationPanel({ project }: { project: ProjectDetail }) {
  const origin = approvalOrigin(project.approvals);
  const review = readReview(project.metadata);
  const needsReview =
    project.state === 'READY_FOR_REVIEW' && review?.decision === 'needs_review' ? review : null;
  const autoPublish = project.publishPolicy === 'AUTO_ON_APPROVAL';
  const canSave = project.sourceType !== 'SLIDESHOW' && project.scripts.length > 0;
  if (!origin && !needsReview && !autoPublish && !canSave) return null;

  return (
    <section
      aria-label="Review and publishing automation"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      {origin === 'automatic' && (
        <p className="flex items-center gap-2 text-sm">
          <BadgeCheck className="size-4 text-emerald-600" strokeWidth={1.5} />
          Approved automatically — a trusted creator and every quality check passed.
        </p>
      )}
      {origin === 'person' && (
        <p className="flex items-center gap-2 text-sm">
          <UserCheck className="size-4" strokeWidth={1.5} /> Approved by a person.
        </p>
      )}
      {needsReview && (
        <p className="flex items-start gap-2 text-sm" role="status">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
          {needsReview.reason ?? 'Needs review by a person.'}
        </p>
      )}
      {autoPublish && <Targets project={project} />}
      {autoPublish && <AutoPublishOutbox projectId={project.id} />}
      {canSave && (
        <div>
          <SaveTemplate projectId={project.id} defaultName={project.name} />
        </div>
      )}
    </section>
  );
}

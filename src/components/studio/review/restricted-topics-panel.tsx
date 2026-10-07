'use client';

import { useTranslations } from 'next-intl';
import { Loader2, ShieldAlert, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseFailure } from '@/lib/client/failure-reasons';
import type { ProjectDetail } from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { useCan } from '../use-can';
import {
  BriefEditor,
  GenerateError,
  NeedsInputPanel,
  useAnchorScroll,
  useGenerate,
} from './generate-brief';

// Spec 13.3 / BACKLOG 20.18 — ideation found that the brief touches topics the brand kit (or the
// business profile) marks as restricted: the project rests in DRAFT with errorReason
// restricted_topics and GET /projects/:id → pendingRestrictedTopics. The owner continues anyway
// (generate with confirmRestrictedTopics) or edits the brief (generate with the new text, which
// ideation checks again). Before 20.18 nothing showed the topics or sent the confirmation.

/** The panel's anchor: the projects list links here (/projects/:id#restricted-topics). */
export const RESTRICTED_TOPICS_ANCHOR = 'restricted-topics';

/** True while the project waits for the owner to confirm restricted topics. */
export function needsTopicConfirmation(
  project: Pick<ProjectDetail, 'state' | 'errorReason'>,
): boolean {
  return (
    project.state === 'DRAFT' && parseFailure(project.errorReason)?.code === 'restricted_topics'
  );
}

export function RestrictedTopicsPanel({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.restricted');
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const { pending, busy, error, generate } = useGenerate(project.id, onChanged);
  const ref = useAnchorScroll(RESTRICTED_TOPICS_ANCHOR);
  const topics = project.pendingRestrictedTopics ?? [];

  return (
    <NeedsInputPanel
      id={RESTRICTED_TOPICS_ANCHOR}
      panelRef={ref}
      icon={
        <ShieldAlert
          className="mt-0.5 size-5 shrink-0 text-warning-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
      }
      title={t('title')}
      body={t('body')}
    >
      {topics.length > 0 && (
        <ul aria-label={t('topicsAria')} className="flex flex-wrap gap-2">
          {topics.map((topic) => (
            <li
              key={topic}
              className="rounded-full border border-warning/40 bg-card px-3 py-1 text-sm"
            >
              <bdi dir="auto">{topic}</bdi>
            </li>
          ))}
        </ul>
      )}
      {mayWrite ? (
        <>
          <div className="flex flex-col gap-1">
            <div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void generate('continue', { confirmRestrictedTopics: true })}
              >
                {pending === 'continue' ? <Loader2 className="animate-spin" /> : <Check />}
                {t('continue')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('continueHint')}</p>
          </div>
          <BriefEditor
            initial={project.description ?? ''}
            busy={busy}
            pending={pending === 'edit'}
            onSubmit={(brief) => void generate('edit', { rawInput: brief })}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      )}
      <GenerateError error={error} />
    </NeedsInputPanel>
  );
}

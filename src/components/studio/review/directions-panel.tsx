'use client';

import { useTranslations } from 'next-intl';
import { Compass, Loader2, Play } from 'lucide-react';
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

// BACKLOG 20.18 — ideation found the brief too vague (DRAFT, errorReason brief_too_vague) and
// suggested up to three directions (GET /projects/:id → directionOptions). The owner picks one or
// rewrites the brief here; either starts generation with directionChosen, so ideation does not
// ask again. Before 20.18 nothing showed the directions and Generate resent the same brief.

/** The panel's anchor: the projects list links here (/projects/:id#directions). */
export const DIRECTIONS_ANCHOR = 'directions';

/** True while the project waits for the owner to choose a direction. */
export function needsDirection(project: Pick<ProjectDetail, 'state' | 'errorReason'>): boolean {
  return project.state === 'DRAFT' && parseFailure(project.errorReason)?.code === 'brief_too_vague';
}

export function DirectionsPanel({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.directions');
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const { pending, busy, error, generate } = useGenerate(project.id, onChanged);
  const ref = useAnchorScroll(DIRECTIONS_ANCHOR);
  const options = project.directionOptions ?? [];

  return (
    <NeedsInputPanel
      id={DIRECTIONS_ANCHOR}
      panelRef={ref}
      icon={
        <Compass
          className="mt-0.5 size-5 shrink-0 text-warning-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
      }
      title={t('title')}
      body={t('body')}
    >
      {options.length > 0 && (
        <ul aria-label={t('optionsAria')} className="grid gap-3 md:grid-cols-3">
          {options.map((option, index) => (
            <li
              key={`${index}-${option}`}
              className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('option', { number: index + 1 })}
                </span>
                <bdi dir="auto" className="text-sm">
                  {option}
                </bdi>
              </div>
              {mayWrite && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-label={t('useAria', { number: index + 1 })}
                  onClick={() =>
                    void generate(`option-${index}`, { rawInput: option, directionChosen: true })
                  }
                >
                  {pending === `option-${index}` ? <Loader2 className="animate-spin" /> : <Play />}
                  {t('use')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {mayWrite ? (
        <BriefEditor
          initial={project.description ?? ''}
          busy={busy}
          pending={pending === 'edit'}
          onSubmit={(brief) => void generate('edit', { rawInput: brief, directionChosen: true })}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      )}
      <GenerateError error={error} />
    </NeedsInputPanel>
  );
}

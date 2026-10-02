'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Compass, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { parseFailure } from '@/lib/client/failure-reasons';
import type { ProjectDetail } from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { BriefHint, briefHintDescribedBy } from '../brief-hint';
import { useCan } from '../use-can';

// BACKLOG 20.18 — ideation found the brief too vague (DRAFT, errorReason brief_too_vague) and
// suggested up to three directions (GET /projects/:id → directionOptions). The owner picks one or
// rewrites the brief here; either starts generation with directionChosen, so ideation does not
// ask again. Before 20.18 nothing showed the directions and Generate resent the same brief.

/** The panel's anchor: the projects list links here (/projects/:id#directions). */
export const DIRECTIONS_ANCHOR = 'directions';
/** The generate API's brief limit (services/projects.ts generateInput.rawInput). */
const BRIEF_MAX = 4_000;

/** True while the project waits for the owner to choose a direction. */
export function needsDirection(project: Pick<ProjectDetail, 'state' | 'errorReason'>): boolean {
  return project.state === 'DRAFT' && parseFailure(project.errorReason)?.code === 'brief_too_vague';
}

type Pending = { kind: 'option'; index: number } | { kind: 'edit' } | null;

export function DirectionsPanel({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.directions');
  const errorMessage = useErrorMessage();
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const [brief, setBrief] = useState(project.description ?? '');
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const editId = useId();
  const ref = useRef<HTMLElement>(null);
  const options = project.directionOptions ?? [];

  // Opened from the projects list (#directions): the panel renders after the project loads, so
  // the browser's own jump to the anchor has already happened.
  useEffect(() => {
    if (window.location.hash === `#${DIRECTIONS_ANCHOR}`)
      ref.current?.scrollIntoView?.({ block: 'start' });
  }, []);

  async function generate(rawInput: string, next: Pending) {
    setPending(next);
    setError(null);
    try {
      await api(`/projects/${project.id}/generate`, {
        method: 'POST',
        body: { rawInput, directionChosen: true },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('started'));
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const edited = brief.trim();

  return (
    <section
      ref={ref}
      id={DIRECTIONS_ANCHOR}
      aria-labelledby={headingId}
      className="flex scroll-mt-20 flex-col gap-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 md:p-5"
    >
      <div className="flex items-start gap-3">
        <Compass className="mt-0.5 size-5 shrink-0 text-amber-600" strokeWidth={1.5} aria-hidden />
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="text-base font-semibold">
            {t('title')}
          </h2>
          <p className="text-sm text-foreground/80">{t('body')}</p>
        </div>
      </div>

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
                  onClick={() => void generate(option, { kind: 'option', index })}
                >
                  {pending?.kind === 'option' && pending.index === index ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Play />
                  )}
                  {t('use')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {mayWrite ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (edited) void generate(edited, { kind: 'edit' });
          }}
        >
          <label htmlFor={editId} className="text-xs font-medium text-muted-foreground">
            {t('editLabel')}
          </label>
          <Textarea
            id={editId}
            value={brief}
            rows={3}
            maxLength={BRIEF_MAX}
            onChange={(e) => setBrief(e.target.value)}
            aria-describedby={briefHintDescribedBy(brief, `${editId}-hint`)}
          />
          <BriefHint text={brief} id={`${editId}-hint`} />
          <div>
            <Button type="submit" disabled={busy || !edited}>
              {pending?.kind === 'edit' ? <Loader2 className="animate-spin" /> : <Play />}
              {t('editSubmit')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

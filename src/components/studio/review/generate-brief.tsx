'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { BriefHint, briefHintDescribedBy } from '../brief-hint';

// BACKLOG 20.18 — shared by the "needs your input" panels of the project page (a brief too vague
// to plan, restricted topics to confirm): start generation with a body, keep the error on screen,
// and an editable brief that regenerates with the owner's changes.

/** The generate API's brief limit (services/projects.ts generateInput.rawInput). */
export const BRIEF_MAX = 4_000;

export interface GenerateBody {
  rawInput?: string;
  directionChosen?: boolean;
  confirmRestrictedTopics?: boolean;
}

/** POST /projects/:id/generate with a key per action, the error kept for an inline alert. */
export function useGenerate(projectId: string, onChanged: () => void) {
  const t = useTranslations('review.needsInput');
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(key: string, body: GenerateBody): Promise<void> {
    setPending(key);
    setError(null);
    try {
      await api(`/projects/${projectId}/generate`, {
        method: 'POST',
        body,
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

  return { pending, busy: pending !== null, error, generate };
}

/** Scrolls the panel into view when the page was opened at its anchor (from the projects list). */
export function useAnchorScroll(anchor: string): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement>(null);
  // The panel renders after the project loads, so the browser's own jump has already happened.
  useEffect(() => {
    if (window.location.hash === `#${anchor}`) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [anchor]);
  return ref;
}

/** The editable brief with the short-brief hint and "Generate with my changes". */
export function BriefEditor({
  initial,
  busy,
  pending,
  onSubmit,
}: {
  initial: string;
  busy: boolean;
  /** True while this editor's own request runs (its button shows the spinner). */
  pending: boolean;
  onSubmit: (brief: string) => void;
}) {
  const t = useTranslations('review.needsInput');
  const [brief, setBrief] = useState(initial);
  const id = useId();
  const edited = brief.trim();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (edited) onSubmit(edited);
      }}
    >
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {t('editLabel')}
      </label>
      <Textarea
        id={id}
        value={brief}
        rows={3}
        maxLength={BRIEF_MAX}
        onChange={(e) => setBrief(e.target.value)}
        aria-describedby={briefHintDescribedBy(brief, `${id}-hint`)}
      />
      <BriefHint text={brief} id={`${id}-hint`} />
      <div>
        <Button type="submit" disabled={busy || !edited}>
          {pending ? <Loader2 className="animate-spin" /> : <Play />}
          {t('editSubmit')}
        </Button>
      </div>
    </form>
  );
}

/** The panel frame: amber, an icon, a heading and the explanation. */
export function NeedsInputPanel({
  id,
  icon,
  title,
  body,
  panelRef,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  body: string;
  panelRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      ref={panelRef}
      id={id}
      aria-labelledby={headingId}
      className="flex scroll-mt-20 flex-col gap-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 md:p-5"
    >
      <div className="flex items-start gap-3">
        {icon}
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          <p className="text-sm text-foreground/80">{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** The error of the last attempt, kept on screen (the panel stays so the owner can retry). */
export function GenerateError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}

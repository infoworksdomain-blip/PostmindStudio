'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import {
  estimateLive,
  etaMinutes,
  IN_PROGRESS_STAGES,
  liveStageOf,
  type LiveStage,
} from '@/lib/studio/live/eta';

// 24.2 — the status chip on calendar / plan / Blitz cards: "Making clips · ~2 min" with a thin
// progress line while a post is being made, then "Ready", "Scheduled", "Posted" or "Failed".
// The ETA counts down every TICK_MS from the run's start (no request), and the live event moves
// the stage on.

export const TICK_MS = 5_000;

// Text is always the foreground colour (small type must reach 4.5:1 on the wash); the stage colour
// is carried by the wash and the leading dot.
const TONE: Readonly<Record<LiveStage, { wash: string; dot: string }>> = {
  planning: { wash: 'bg-primary/10', dot: 'bg-primary' },
  making_clips: { wash: 'bg-primary/10', dot: 'bg-primary' },
  composing: { wash: 'bg-primary/10', dot: 'bg-primary' },
  ready: { wash: 'bg-success/10', dot: 'bg-success' },
  scheduled: { wash: 'bg-secondary', dot: 'bg-muted-foreground' },
  posted: { wash: 'bg-success/10', dot: 'bg-success' },
  failed: { wash: 'bg-destructive/10', dot: 'bg-destructive' },
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export interface StatusChipProps {
  live?: LiveProjectEvent;
  /** The project state the screen already knows (used until a live event arrives). */
  projectState?: string | null;
  /** A calendar card is one publication: its state wins once the post is made. */
  publicationState?: string | null;
  compact?: boolean;
  className?: string;
}

export function StatusChip({
  live,
  projectState,
  publicationState,
  compact = false,
  className,
}: StatusChipProps) {
  const t = useTranslations('live');
  const stage = liveStageOf(live?.state ?? projectState ?? '', publicationState);
  const inProgress = stage !== null && IN_PROGRESS_STAGES.has(stage);
  const now = useNow(inProgress);
  if (!stage) return null;
  const estimate = estimateLive({
    stage,
    format: live?.format ?? null,
    startedAtMs: live?.startedAt ? Date.parse(live.startedAt) : null,
    nowMs: now,
  });
  const label = t(`stage.${stage}`);
  const eta =
    inProgress && estimate.etaSec !== null
      ? estimate.etaSec > 0
        ? t('eta', { minutes: etaMinutes(estimate.etaSec) })
        : t('finishing')
      : null;
  const text = eta ? t('withEta', { stage: label, eta }) : label;
  return (
    <span
      data-live-stage={stage}
      title={text}
      className={cn(
        'relative inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full font-medium whitespace-nowrap text-foreground',
        compact ? 'px-1.5 py-px text-[0.6rem]' : 'px-2 py-0.5 text-xs',
        TONE[stage].wash,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          TONE[stage].dot,
          inProgress && 'animate-pulse',
        )}
      />
      <span className="truncate">{text}</span>
      {inProgress && estimate.progressPct !== null && (
        <span
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={estimate.progressPct}
          className={cn('absolute inset-x-0 bottom-0 h-0.5 bg-foreground/10')}
        >
          <span
            className={cn('block h-full transition-[inline-size] duration-700', TONE[stage].dot)}
            style={{ inlineSize: `${estimate.progressPct}%` }}
          />
        </span>
      )}
    </span>
  );
}

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

const TONE: Readonly<Record<LiveStage, string>> = {
  planning: 'bg-primary/10 text-primary',
  making_clips: 'bg-primary/10 text-primary',
  composing: 'bg-primary/10 text-primary',
  ready: 'bg-success/15 text-success',
  scheduled: 'bg-secondary text-muted-foreground',
  posted: 'bg-success/15 text-success',
  failed: 'bg-destructive/10 text-destructive',
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
        'relative inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full font-medium whitespace-nowrap',
        compact ? 'px-1.5 py-px text-[0.6rem]' : 'px-2 py-0.5 text-xs',
        TONE[stage],
        className,
      )}
    >
      {inProgress && (
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" />
      )}
      <span className="truncate">{text}</span>
      {inProgress && estimate.progressPct !== null && (
        <span
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={estimate.progressPct}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-current/15"
        >
          <span
            className="block h-full bg-current transition-[inline-size] duration-700"
            style={{ inlineSize: `${estimate.progressPct}%` }}
          />
        </span>
      )}
    </span>
  );
}

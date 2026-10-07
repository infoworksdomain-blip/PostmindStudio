'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
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

// BACKLOG 25.3: the chip is the shared StatusPill (its washes and text colours are contrast-tested);
// the stage picks the tone, and work in progress pulses (the `live` tone).
const TONE: Readonly<Record<LiveStage, StatusTone>> = {
  planning: 'live',
  making_clips: 'live',
  composing: 'live',
  ready: 'good',
  scheduled: 'neutral',
  posted: 'good',
  failed: 'bad',
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
    <StatusPill
      tone={TONE[stage]}
      dot
      size="sm"
      data-live-stage={stage}
      title={text}
      className={cn(
        'relative max-w-full shrink overflow-hidden',
        compact && 'h-4 gap-1 px-1.5 text-[0.6rem]',
        className,
      )}
    >
      <span className="truncate">{text}</span>
      {inProgress && estimate.progressPct !== null && (
        <span
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={estimate.progressPct}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/10"
        >
          <span
            className="block h-full bg-primary transition-[inline-size] duration-700"
            style={{ inlineSize: `${estimate.progressPct}%` }}
          />
        </span>
      )}
    </StatusPill>
  );
}

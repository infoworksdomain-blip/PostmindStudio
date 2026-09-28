'use client';

import { Mic, Type } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { useAnalysisLabels } from './analysis-labels';
import type { Blueprint } from './types';

// The TEMPLATE blueprint (A3.6) drawn as a proportional strip: one block per shot, width by
// duration, followed by an ordered list that screen readers get in full.

const SHOT_TONE = [
  'bg-chart-1/85',
  'bg-chart-2/80',
  'bg-chart-3/85',
  'bg-chart-4/85',
  'bg-chart-5/80',
] as const;

export function BlueprintTimeline({ blueprint }: { blueprint: Blueprint }) {
  const t = useTranslations('library.timeline');
  const f = useFormat();
  const labels = useAnalysisLabels();
  const total = blueprint.totalDurationSec || 1;
  const seconds = (s: number) =>
    f.number(s, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <div>
      <div
        aria-hidden
        className="flex h-12 w-full gap-0.5 overflow-hidden rounded-lg border border-border bg-secondary"
      >
        {blueprint.shots.map((shot, i) => (
          <div
            key={i}
            title={t('shotTitle', {
              type: labels.shotType(shot.type),
              seconds: f.number(shot.durationSec),
            })}
            className={cn(
              'flex min-w-1 items-end px-1 pb-1 text-[0.6rem] font-semibold text-white',
              SHOT_TONE[i % SHOT_TONE.length],
            )}
            style={{ width: `${(shot.durationSec / total) * 100}%` }}
          >
            <span className="truncate">{f.number(i + 1)}</span>
          </div>
        ))}
      </div>
      <ol aria-label={t('shotList')} className="mt-4 divide-y divide-border/70">
        {blueprint.shots.map((shot, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.75rem_1fr_auto] items-baseline gap-2 py-2.5 text-sm"
          >
            <span className="tabular text-xs text-muted-foreground">
              {f.number(i + 1, { minimumIntegerDigits: 2 })}
            </span>
            <span className="min-w-0">
              <span className="font-medium">{labels.shotType(shot.type)}</span>
              <span className="block text-xs text-muted-foreground">
                {blueprint.transitionSequence[i]
                  ? t('overlayThen', {
                      overlay: labels.overlay(shot.overlayStyle),
                      transition: blueprint.transitionSequence[i],
                    })
                  : t('overlay', { overlay: labels.overlay(shot.overlayStyle) })}
              </span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {shot.voiceoverPresent && (
                <Mic className="size-3.5" aria-label={t('voiceover')} role="img" />
              )}
              {shot.hasOnScreenText && (
                <Type className="size-3.5" aria-label={t('onScreenText')} role="img" />
              )}
              <span className="tabular">
                {t('seconds', { seconds: seconds(shot.durationSec) })}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

'use client';

import { Mic, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { humanise } from './library-utils';
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
  const total = blueprint.totalDurationSec || 1;
  return (
    <div>
      <div
        aria-hidden
        className="flex h-12 w-full gap-0.5 overflow-hidden rounded-lg border border-border bg-secondary"
      >
        {blueprint.shots.map((shot, i) => (
          <div
            key={i}
            title={`${humanise(shot.type)} · ${shot.durationSec}s`}
            className={cn(
              'flex min-w-1 items-end px-1 pb-1 text-[0.6rem] font-semibold text-white',
              SHOT_TONE[i % SHOT_TONE.length],
            )}
            style={{ width: `${(shot.durationSec / total) * 100}%` }}
          >
            <span className="truncate">{i + 1}</span>
          </div>
        ))}
      </div>
      <ol aria-label="Shot list" className="mt-4 divide-y divide-border/70">
        {blueprint.shots.map((shot, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.75rem_1fr_auto] items-baseline gap-2 py-2.5 text-sm"
          >
            <span className="tabular text-xs text-muted-foreground">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="min-w-0">
              <span className="font-medium">{humanise(shot.type)}</span>
              <span className="block text-xs text-muted-foreground">
                Overlay: {humanise(shot.overlayStyle)}
                {blueprint.transitionSequence[i] && ` · then ${blueprint.transitionSequence[i]}`}
              </span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {shot.voiceoverPresent && (
                <Mic className="size-3.5" aria-label="Voiceover" role="img" />
              )}
              {shot.hasOnScreenText && (
                <Type className="size-3.5" aria-label="On-screen text" role="img" />
              )}
              <span className="tabular">{shot.durationSec.toFixed(1)}s</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

'use client';

import { formatDuration } from '@/lib/client/format';
import type { ShotSummary } from '@/lib/client/types';
import { cn } from '@/lib/utils';

// Spec 14.2 shot strip: one tile per shot, width proportional to its duration, coloured by
// state. Selecting a tile opens its detail (regenerate / edit / overlays).

const STATE_CLASS: Record<string, string> = {
  READY: 'border-border bg-card',
  FAILED: 'border-destructive/50 bg-destructive/5',
  GENERATING: 'border-primary/40 bg-primary/5',
  QUEUED: 'border-primary/30 bg-primary/5',
  PLANNED: 'border-dashed border-border bg-transparent',
  SKIPPED: 'border-dashed border-border bg-muted/40',
};

export function treatmentLabel(treatment: string): string {
  return treatment.replace(/_/g, ' ').toLowerCase();
}

export function ShotStrip({
  shots,
  selectedId,
  onSelect,
  label = 'Shots',
}: {
  shots: ShotSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  label?: string;
}) {
  if (shots.length === 0)
    return <p className="text-sm text-muted-foreground">No shots have been planned yet.</p>;
  const total = shots.reduce((sum, s) => sum + s.durationSec, 0) || 1;
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <ol aria-label={label} className="flex min-w-full gap-1.5">
        {shots.map((shot, i) => {
          const selected = shot.id === selectedId;
          return (
            <li
              key={shot.id}
              style={{ flexGrow: shot.durationSec / total, flexBasis: 0 }}
              className="min-w-[4.5rem]"
            >
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Shot ${i + 1}, ${formatDuration(shot.durationSec)}, ${treatmentLabel(shot.visualTreatment)}, ${shot.state.toLowerCase()}`}
                onClick={() => onSelect(shot.id)}
                className={cn(
                  'flex h-16 w-full flex-col justify-between rounded-md border px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  STATE_CLASS[shot.state] ?? 'border-border',
                  selected && 'ring-2 ring-foreground',
                )}
              >
                <span className="flex items-center justify-between text-xs font-medium">
                  <span className="tabular">{String(i + 1).padStart(2, '0')}</span>
                  {shot.state === 'GENERATING' && (
                    <span aria-hidden className="size-1.5 animate-rec rounded-full bg-primary" />
                  )}
                </span>
                <span className="truncate text-[0.65rem] text-muted-foreground">
                  {formatDuration(shot.durationSec)} · {treatmentLabel(shot.visualTreatment)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

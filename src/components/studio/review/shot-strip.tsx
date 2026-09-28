'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
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

const TREATMENTS = [
  'AI_CLIP',
  'AI_AVATAR',
  'STOCK_FOOTAGE',
  'IMAGE_STILL',
  'MOTION_GRAPHICS',
  'USER_UPLOAD',
  'TEXT_CARD',
  'TRANSITION',
] as const;
const SHOT_STATES = ['PLANNED', 'QUEUED', 'GENERATING', 'READY', 'FAILED', 'SKIPPED'] as const;
const oneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** A readable label for a treatment the catalogue does not know. */
export function treatmentLabel(treatment: string): string {
  return treatment.replace(/_/g, ' ').toLowerCase();
}

/** Visual treatment and shot state in the interface language. */
export function useShotLabels() {
  const t = useTranslations('review.shotStrip');
  return {
    treatment: (value: string) =>
      oneOf(TREATMENTS, value) ? t(`treatments.${value}`) : treatmentLabel(value),
    state: (value: string) =>
      oneOf(SHOT_STATES, value) ? t(`states.${value}`) : value.toLowerCase(),
  };
}

export function ShotStrip({
  shots,
  selectedId,
  onSelect,
  label,
}: {
  shots: ShotSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  label?: string;
}) {
  const t = useTranslations('review.shotStrip');
  const f = useFormat();
  const labels = useShotLabels();
  if (shots.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  const total = shots.reduce((sum, s) => sum + s.durationSec, 0) || 1;
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <ol aria-label={label ?? t('aria')} className="flex min-w-full gap-1.5">
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
                aria-label={t('tileAria', {
                  n: i + 1,
                  duration: f.duration(shot.durationSec),
                  treatment: labels.treatment(shot.visualTreatment),
                  state: labels.state(shot.state),
                })}
                onClick={() => onSelect(shot.id)}
                className={cn(
                  'flex h-16 w-full flex-col justify-between rounded-md border px-2 py-1.5 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  STATE_CLASS[shot.state] ?? 'border-border',
                  selected && 'ring-2 ring-foreground',
                )}
              >
                <span className="flex items-center justify-between text-xs font-medium">
                  <span className="tabular">{f.number(i + 1, { minimumIntegerDigits: 2 })}</span>
                  {shot.state === 'GENERATING' && (
                    <span aria-hidden className="size-1.5 animate-rec rounded-full bg-primary" />
                  )}
                </span>
                <span className="truncate text-[0.65rem] text-muted-foreground">
                  {f.duration(shot.durationSec)} · {labels.treatment(shot.visualTreatment)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

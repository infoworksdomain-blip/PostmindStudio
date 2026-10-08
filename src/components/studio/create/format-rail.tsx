'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlignCenter,
  Check,
  Clapperboard,
  GalleryHorizontal,
  Layers,
  MonitorPlay,
  Upload,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { nextEnabled, rovingDelta } from '@/components/ui/roving';
import { cn } from '@/lib/utils';
import type { CreateSource } from './body';

// BACKLOG 25.7 — the format rail: the first choice on Create. Seven formats as a radiogroup of
// cards (name + one line each), arrow keys move and select (roving tab stop, RTL-aware). On phones
// it scrolls sideways so the brief stays near the top; from sm it wraps into a grid. No format is
// plan-gated today (billing/catalogue.ts has no per-format flag), so none renders a lock.

export const FORMATS: ReadonlyArray<{ key: CreateSource; icon: LucideIcon }> = [
  { key: 'BRIEF', icon: Clapperboard },
  { key: 'SLIDESHOW', icon: Layers },
  { key: 'CAROUSEL', icon: GalleryHorizontal },
  { key: 'UPLOAD', icon: Upload },
  // 21.4: a generated actor talks about the product (UGC style).
  { key: 'UGC', icon: UserRound },
  // 22.1: a reaction hook, then the business's own demo video (Fastlane's main format).
  { key: 'HOOK_DEMO', icon: MonitorPlay },
  // 22.2: one block of text over a calm background video.
  { key: 'WALL_OF_TEXT', icon: AlignCenter },
];

export interface FormatRailProps {
  value: CreateSource;
  onChange: (source: CreateSource) => void;
  /** Shown under the rail, e.g. why the plan starts on Slideshow. */
  note?: string | null;
}

export function FormatRail({ value, onChange, note }: FormatRailProps) {
  const t = useTranslations('create.screen');
  const labelId = useId();
  const noteId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const off = FORMATS.map(() => false);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === event.target);
    if (from === -1) return;
    const delta = rovingDelta(event, FORMATS.length, from);
    if (delta === null) return;
    event.preventDefault();
    const next = nextEnabled(from, delta, off);
    const format = next === null ? undefined : FORMATS[next];
    if (next === null || !format) return;
    refs.current[next]?.focus();
    onChange(format.key);
  };

  return (
    <section aria-labelledby={labelId} className="min-w-0">
      <h2 id={labelId} className="mb-2.5 text-xs font-medium text-muted-foreground">
        {t('sourcesAria')}
      </h2>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={note ? noteId : undefined}
        onKeyDown={onKey}
        data-slot="format-rail"
        className={cn(
          '-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]',
          'sm:mx-0 sm:grid sm:snap-none sm:grid-cols-4 sm:overflow-visible sm:px-0 lg:grid-cols-7',
        )}
      >
        {FORMATS.map(({ key, icon: Icon }, i) => {
          const checked = key === value;
          const lineId = `${labelId}-${key}`;
          return (
            <button
              key={key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${lineId}-name`}
              aria-describedby={lineId}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(key)}
              data-state={checked ? 'checked' : 'unchecked'}
              className={cn(
                'group relative flex w-40 shrink-0 snap-start flex-col items-start gap-1.5 rounded-xl border p-3 text-start sm:w-auto',
                'transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) ease-standard',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                checked
                  ? 'border-foreground/70 bg-surface-active text-foreground shadow-[0_1px_0_rgb(0_0_0/0.04)]'
                  : 'border-border-strong bg-card text-foreground-secondary hover:border-input hover:bg-surface-raised hover:text-foreground',
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <Icon className="size-4.5" strokeWidth={1.5} aria-hidden />
                <Check
                  aria-hidden
                  strokeWidth={2.5}
                  className={cn('size-3.5', checked ? 'opacity-100' : 'opacity-0')}
                />
              </span>
              <span
                id={`${lineId}-name`}
                className="text-sm leading-snug font-medium text-foreground"
              >
                {t(`formats.${key}.name`)}
              </span>
              <span id={lineId} className="text-xs leading-snug text-foreground-secondary">
                {t(`formats.${key}.line`)}
              </span>
            </button>
          );
        })}
      </div>
      {note && (
        <p id={noteId} className="mt-2 text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </section>
  );
}

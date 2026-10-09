'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { nextEnabled, rovingDelta } from '@/components/ui/roving';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { CreateSource } from './body';
import type { VideoModelView } from './generate-body';

// BACKLOG 25.8 — "Video model" on Create: Automatic (the router's order, with failover) or one of
// the models the organisation can really use on this run's tier (GET /video-models). Each card
// shows only what the catalogue knows: the name, typical time per clip, what it takes (text or a
// photo) and its longest clip; platform staff also see the price of a 6 s clip. No camera, motion,
// resolution or audio control is rendered: no AI-clip adapter accepts one (catalogue header).
// The list stays folded behind "Change model" (most people keep Automatic); folded, the current
// choice is shown with what it does.

const AUTOMATIC = '';

export interface VideoModelPickerProps {
  source: CreateSource;
  /** The models the run's tier allows (generate-body.ts modelsForTier). */
  models: readonly VideoModelView[];
  /** The chosen providerId; null = Automatic. */
  value: string | null | undefined;
  onChange: (providerId: string | null) => void;
  /** Platform staff see each model's price (operator decision 2026-10-04). */
  showCosts?: boolean;
  /** A model was chosen that this run's tier cannot use (Automatic applies). */
  droppedChoice?: boolean;
}

export function VideoModelPicker(props: VideoModelPickerProps) {
  const { models, value, onChange, showCosts = false, source } = props;
  const t = useTranslations('create.videoModel');
  const f = useFormat();
  const labelId = useId();
  const hintId = useId();
  const listId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  if (models.length === 0) return null;

  const selected = value && models.some((m) => m.providerId === value) ? value : AUTOMATIC;
  const options: Array<{ id: string; title: string; meta: ReactNode }> = [
    { id: AUTOMATIC, title: t('automatic'), meta: t('automaticLine') },
    ...models.map((m) => ({
      id: m.providerId,
      title: m.displayName,
      meta: [
        m.typicalLatencySec
          ? t('speed', { minutes: Math.max(1, Math.round(m.typicalLatencySec / 60)) })
          : null,
        t(
          `capability.${m.capabilities.length > 1 ? 'both' : (m.capabilities[0] ?? 'text_to_video')}`,
        ),
        t('maxClip', { seconds: m.maxClipSec }),
        showCosts && m.pencePerClip !== undefined
          ? t('costStaff', { amount: f.pence(m.pencePerClip) })
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  ];
  const choose = (id: string) => onChange(id === AUTOMATIC ? null : id);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === event.target);
    if (from === -1) return;
    const delta = rovingDelta(event, options.length, from);
    if (delta === null) return;
    event.preventDefault();
    const next = nextEnabled(
      from,
      delta,
      options.map(() => false),
    );
    const option = next === null ? undefined : options[next];
    if (next === null || !option) return;
    refs.current[next]?.focus();
    choose(option.id);
  };

  const current = options.find((o) => o.id === selected) ?? options[0];
  return (
    <section aria-labelledby={labelId} className="grid gap-2" data-slot="video-model-picker">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={labelId} className="text-xs font-medium text-muted-foreground">
          {t('legend')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t('hide') : t('change')}
          <ChevronDown
            aria-hidden
            data-icon="inline-end"
            className={cn(
              'transition-transform duration-(--duration-fast) motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </Button>
      </div>
      <p id={hintId} className="-mt-1 text-xs text-muted-foreground">
        {t(`hint.${source === 'UGC' ? 'UGC' : source === 'HOOK_DEMO' ? 'HOOK_DEMO' : 'BRIEF'}`)}
        {props.droppedChoice && <> {t('droppedChoice')}</>}
      </p>
      {!open && current && (
        <p
          className="grid gap-0.5 rounded-lg border border-border bg-card px-3 py-2"
          data-testid="video-model-current"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {current.id === AUTOMATIC && (
              <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
            )}
            {current.title}
          </span>
          <span className="text-xs text-muted-foreground">{current.meta}</span>
        </p>
      )}
      <div
        id={listId}
        hidden={!open}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onKeyDown={onKey}
        className="grid gap-1.5"
      >
        {options.map((o, i) => {
          const checked = o.id === selected;
          const metaId = `${labelId}-${o.id || 'auto'}`;
          return (
            <button
              key={o.id || 'auto'}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${metaId}-name`}
              aria-describedby={metaId}
              tabIndex={checked ? 0 : -1}
              onClick={() => choose(o.id)}
              data-state={checked ? 'checked' : 'unchecked'}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-1.5 text-start',
                'transition-[background-color,border-color] duration-(--duration-fast) ease-standard',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                checked
                  ? 'border-foreground/70 bg-surface-active'
                  : 'border-border hover:border-input hover:bg-surface-raised',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                  checked ? 'border-foreground bg-foreground text-background' : 'border-input',
                )}
              >
                {checked && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span
                  id={`${metaId}-name`}
                  className="flex items-center gap-1.5 text-sm font-medium"
                >
                  {o.id === AUTOMATIC && (
                    <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
                  )}
                  {o.title}
                </span>
                <span id={metaId} className="text-xs text-muted-foreground">
                  {o.meta}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

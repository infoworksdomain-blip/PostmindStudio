'use client';

import { useTranslations } from 'next-intl';
import { AlignCenter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Field, NativeSelect } from '../review/field';
import {
  countWords,
  WALL_SECONDS,
  WALL_TEXT_MAX_CHARS,
  WALL_TEXT_MAX_LINES,
  WALL_TEXT_MAX_WORDS,
  type WallOfTextChoice,
} from './body';

// BACKLOG 22.2 — Create → "Wall of text": one large block of text over a calm background video,
// with music, for the whole video (6–12 s). The owner writes the text (at most 60 words, one idea
// per line) or leaves it empty and Studio writes it from the description. One video of the
// allowance; no cost is shown.

const BACKGROUNDS = ['calm', 'nature', 'city', 'abstract'] as const;

export function WallOfTextOptions({
  value,
  onChange,
}: {
  value: WallOfTextChoice;
  onChange: (next: WallOfTextChoice) => void;
}) {
  const t = useTranslations('create.wallOfText');
  const set = (next: Partial<WallOfTextChoice>) => onChange({ ...value, ...next });
  const words = countWords(value.text);
  const lines = value.text.split(/\r?\n/).filter((l) => l.trim()).length;
  const over = words > WALL_TEXT_MAX_WORDS || lines > WALL_TEXT_MAX_LINES;
  return (
    <section
      aria-labelledby="create-wall-title"
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4"
    >
      <div className="flex items-start gap-2">
        <AlignCenter className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} aria-hidden />
        <div>
          <h2 id="create-wall-title" className="text-sm font-medium">
            {t('title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('intro')}</p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="create-wall-text" className="text-sm">
          {t('text')}
        </label>
        <textarea
          id="create-wall-text"
          value={value.text}
          rows={5}
          maxLength={WALL_TEXT_MAX_CHARS}
          dir="auto"
          placeholder={t('textPlaceholder')}
          aria-describedby="create-wall-text-hint"
          onChange={(e) => set({ text: e.target.value })}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
        />
        <p
          id="create-wall-text-hint"
          className={cn('text-xs', over ? 'text-destructive' : 'text-muted-foreground')}
        >
          {t('textHint', { count: words, max: WALL_TEXT_MAX_WORDS })}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="create-wall-background" label={t('background')}>
          <NativeSelect
            id="create-wall-background"
            value={value.background}
            onChange={(e) => set({ background: e.target.value as WallOfTextChoice['background'] })}
          >
            {BACKGROUNDS.map((b) => (
              <option key={b} value={b}>
                {t(`backgrounds.${b}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="create-wall-length" label={t('length')}>
          <NativeSelect
            id="create-wall-length"
            value={String(value.durationSec)}
            onChange={(e) => set({ durationSec: Number(e.target.value) })}
          >
            {WALL_SECONDS.map((s) => (
              <option key={s} value={s}>
                {t('seconds', { count: s })}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
    </section>
  );
}

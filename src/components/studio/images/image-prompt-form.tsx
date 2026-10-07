'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  IMAGE_ASPECTS,
  isValidRequest,
  PROMPT_MAX,
  STYLE_MAX,
  type ImageAspect,
  type ImageRequest,
} from './image-studio-model';

// BACKLOG 25.8 — Image Studio's prompt-first workspace: describe the picture, optionally a style,
// pick a shape. Exactly the fields the API takes; nothing pretends to choose a model or a count.

export function ImagePromptForm({
  value,
  onChange,
  onSubmit,
  busy,
  disabled = false,
}: {
  value: ImageRequest;
  onChange: (next: ImageRequest) => void;
  onSubmit: () => void;
  busy: boolean;
  /** Not in the plan: the form shows but cannot send. */
  disabled?: boolean;
}) {
  const t = useTranslations('images.form');
  const id = useId();
  const valid = isValidRequest(value);
  const off = disabled || busy;
  return (
    <form
      aria-label={t('aria')}
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !off) onSubmit();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-prompt`} className="text-base font-semibold">
          {t('prompt')}
        </Label>
        <Textarea
          id={`${id}-prompt`}
          rows={4}
          maxLength={PROMPT_MAX}
          disabled={disabled}
          placeholder={t('promptPlaceholder')}
          aria-describedby={`${id}-prompt-hint`}
          value={value.prompt}
          onChange={(e) => onChange({ ...value, prompt: e.target.value })}
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter sends, as in other prompt boxes; Enter alone adds a line.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && valid && !off) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="min-h-28 text-base"
        />
        <p id={`${id}-prompt-hint`} className="text-xs text-muted-foreground">
          {t('promptHint')}
        </p>
      </div>
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-style`}>{t('style')}</Label>
          <Input
            id={`${id}-style`}
            maxLength={STYLE_MAX}
            disabled={disabled}
            placeholder={t('stylePlaceholder')}
            value={value.style}
            onChange={(e) => onChange({ ...value, style: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span id={`${id}-shape`} className="text-sm font-medium">
            {t('shape')}
          </span>
          <ChoiceChips<ImageAspect>
            type="single"
            aria-labelledby={`${id}-shape`}
            disabled={disabled}
            value={value.aspectRatio}
            onChange={(aspectRatio) => onChange({ ...value, aspectRatio })}
            options={IMAGE_ASPECTS.map((a) => ({
              value: a,
              label: a,
              description: t(`shapes.${a.replace(':', 'x') as '1x1' | '4x5' | '9x16' | '16x9'}`),
            }))}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={!valid || off} loading={busy}>
          {!busy && <Sparkles />} {busy ? t('generating') : t('generate')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('timing')}</p>
      </div>
    </form>
  );
}

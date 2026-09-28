'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { BrandKit } from '@/lib/client/types';
import { parseList } from './types';

// Create / edit a brand kit (spec 8.5, 10): palette, fonts, tone, audience, CTA templates and
// restricted topics. Field rules mirror services/brand-kits.ts so mistakes show before saving.

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9 -]{1,64}$|^upload:[A-Za-z0-9_-]{1,64}$/;

export type BrandKitPayload = Pick<
  BrandKit,
  | 'name'
  | 'colourPalette'
  | 'fontPrimary'
  | 'fontSecondary'
  | 'toneKeywords'
  | 'audienceProfile'
  | 'ctaTemplates'
  | 'restrictedTopics'
>;

interface Draft {
  name: string;
  palette: string;
  fontPrimary: string;
  fontSecondary: string;
  tone: string;
  audience: string;
  ctas: string;
  restricted: string;
}

function toDraft(kit?: BrandKit): Draft {
  return {
    name: kit?.name ?? '',
    palette: kit?.colourPalette.join(', ') ?? '',
    fontPrimary: kit?.fontPrimary ?? '',
    fontSecondary: kit?.fontSecondary ?? '',
    tone: kit?.toneKeywords.join(', ') ?? '',
    audience: kit?.audienceProfile ?? '',
    ctas: kit?.ctaTemplates.map((c) => `${c.label} | ${c.template}`).join('\n') ?? '',
    restricted: kit?.restrictedTopics.join(', ') ?? '',
  };
}

function parseCtas(text: string): BrandKitPayload['ctaTemplates'] {
  return text
    .split('\n')
    .map((line) => line.split('|').map((s) => s.trim()))
    .filter(([label, template]) => label && template)
    .map(([label, template]) => ({ label: label as string, template: template as string }));
}

const MAX_COLOURS = 8;
const MAX_TONES = 10;
const MAX_CTAS = 10;

/** The first problem with a draft: a key under business.kitForm.problems and its arguments. */
export type KitProblem =
  | { key: 'name' }
  | { key: 'tooManyColours'; values: { max: number } }
  | { key: 'badColour'; values: { colour: string } }
  | { key: 'badFont'; values: { font: string } }
  | { key: 'tooManyTones'; values: { max: number } }
  | { key: 'tooManyCtas'; values: { max: number } };

/** Validate a draft; returns the payload or the first problem. */
export function toPayload(d: Draft): { payload?: BrandKitPayload; problem?: KitProblem } {
  const palette = parseList(d.palette);
  if (!d.name.trim()) return { problem: { key: 'name' } };
  if (palette.length > MAX_COLOURS)
    return { problem: { key: 'tooManyColours', values: { max: MAX_COLOURS } } };
  const bad = palette.find((c) => !HEX.test(c));
  if (bad) return { problem: { key: 'badColour', values: { colour: bad } } };
  for (const f of [d.fontPrimary, d.fontSecondary]) {
    if (f.trim() && !FONT.test(f.trim()))
      return { problem: { key: 'badFont', values: { font: f } } };
  }
  const tone = parseList(d.tone);
  if (tone.length > MAX_TONES)
    return { problem: { key: 'tooManyTones', values: { max: MAX_TONES } } };
  const ctas = parseCtas(d.ctas);
  if (ctas.length > MAX_CTAS) return { problem: { key: 'tooManyCtas', values: { max: MAX_CTAS } } };
  return {
    payload: {
      name: d.name.trim(),
      colourPalette: palette.map((c) => c.toUpperCase()),
      fontPrimary: d.fontPrimary.trim() || null,
      fontSecondary: d.fontSecondary.trim() || null,
      toneKeywords: tone,
      audienceProfile: d.audience.trim() || null,
      ctaTemplates: ctas,
      restrictedTopics: parseList(d.restricted),
    },
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function BrandKitDialog({
  open,
  onOpenChange,
  kit,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kit?: BrandKit;
  /** Resolve true when saved (closes the dialog). */
  onSubmit: (payload: BrandKitPayload) => Promise<boolean>;
}) {
  const t = useTranslations('business.kitForm');
  const [draft, setDraft] = useState(() => toDraft(kit));
  const [busy, setBusy] = useState(false);
  const { payload, problem } = toPayload(draft);
  const swatches = parseList(draft.palette).filter((c) => HEX.test(c));
  const set = (key: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  async function submit() {
    if (!payload) return;
    setBusy(true);
    try {
      if (await onSubmit(payload)) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{kit ? t('editTitle', { name: kit.name }) : t('newTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          id="brand-kit-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field id="kit-name" label={t('name')}>
            <Input id="kit-name" maxLength={120} value={draft.name} onChange={set('name')} />
          </Field>
          <Field id="kit-palette" label={t('colours')} hint={t('coloursHint')}>
            <Input id="kit-palette" value={draft.palette} onChange={set('palette')} />
            {swatches.length > 0 && (
              <div className="flex gap-1.5" aria-hidden>
                {swatches.map((c) => (
                  <span
                    key={c}
                    className="size-6 rounded-md ring-1 ring-foreground/10"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="kit-font-primary" label={t('headingFont')}>
              <Input
                id="kit-font-primary"
                value={draft.fontPrimary}
                onChange={set('fontPrimary')}
              />
            </Field>
            <Field id="kit-font-secondary" label={t('bodyFont')}>
              <Input
                id="kit-font-secondary"
                value={draft.fontSecondary}
                onChange={set('fontSecondary')}
              />
            </Field>
          </div>
          <Field id="kit-tone" label={t('tone')} hint={t('toneHint')}>
            <Input id="kit-tone" value={draft.tone} onChange={set('tone')} />
          </Field>
          <Field id="kit-audience" label={t('audience')}>
            <Textarea
              id="kit-audience"
              rows={2}
              maxLength={1000}
              value={draft.audience}
              onChange={set('audience')}
            />
          </Field>
          <Field id="kit-ctas" label={t('ctas')} hint={t('ctasHint')}>
            <Textarea id="kit-ctas" rows={3} value={draft.ctas} onChange={set('ctas')} />
          </Field>
          <Field id="kit-restricted" label={t('restricted')} hint={t('restrictedHint')}>
            <Input id="kit-restricted" value={draft.restricted} onChange={set('restricted')} />
          </Field>
          {problem && draft.name.trim() && (
            <p role="alert" className="text-xs text-destructive">
              {'values' in problem
                ? t(`problems.${problem.key}`, problem.values)
                : t(`problems.${problem.key}`)}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="brand-kit-form" disabled={!payload || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {kit ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

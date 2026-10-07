'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { IconButton } from '@/components/ui/icon-button';

// The brand-kit step's three pickers: logo palette swatches (removable), a short font list
// (plain names that satisfy the brand-kit FONT rule) and tone chips (up to three). Tone values are
// stored in English (they steer script generation); only their labels are localised.

export const FONTS = ['Inter', 'Fraunces', 'Poppins', 'Playfair Display', 'DM Sans'] as const;
export const TONES = [
  'Warm',
  'Friendly',
  'Playful',
  'Bold',
  'Professional',
  'Calm',
  'Witty',
  'Premium',
] as const;
export const MAX_TONES = 3;

export type Tone = (typeof TONES)[number];

/** Catalogue key (onboarding.brandKit.tones.<key>) of each tone's label. */
const TONE_KEY = {
  Warm: 'warm',
  Friendly: 'friendly',
  Playful: 'playful',
  Bold: 'bold',
  Professional: 'professional',
  Calm: 'calm',
  Witty: 'witty',
  Premium: 'premium',
} as const satisfies Record<Tone, string>;

export function PaletteSwatches({
  colours,
  onRemove,
}: {
  colours: string[];
  onRemove: (colour: string) => void;
}) {
  const t = useTranslations('onboarding.brandKit');
  return (
    <ul aria-label={t('paletteAria')} className="flex flex-wrap gap-2">
      {colours.map((c) => (
        <li
          key={c}
          className="flex items-center gap-2 rounded-lg border border-border py-1 ps-1.5 pe-1"
        >
          <span
            aria-hidden
            className="size-6 rounded-md border border-border"
            style={{ backgroundColor: c }}
          />
          <span dir="ltr" className="font-mono text-xs">
            {c}
          </span>
          <IconButton
            type="button"
            size="icon-xs"
            label={t('removeColour', { colour: c })}
            onClick={() => onRemove(c)}
          >
            <X />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

export function FontPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (font: string) => void;
}) {
  const t = useTranslations('onboarding.brandKit');
  return (
    <ChoiceChips<string>
      type="single"
      label={t('fontAria')}
      value={value}
      onChange={onChange}
      options={FONTS.map((font) => ({
        value: font,
        label: <span style={{ fontFamily: `'${font}', ui-sans-serif, system-ui` }}>{font}</span>,
      }))}
    />
  );
}

export function ToneChips({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tones: string[]) => void;
}) {
  const t = useTranslations('onboarding.brandKit');
  const full = value.length >= MAX_TONES;
  return (
    <ChoiceChips<string>
      type="multiple"
      label={t('toneAria')}
      value={value}
      onChange={onChange}
      options={TONES.map((tone) => ({
        value: tone,
        label: t(`tones.${TONE_KEY[tone]}`),
        disabled: !value.includes(tone) && full,
      }))}
    />
  );
}

'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// The brand-kit step's three pickers: logo palette swatches (removable), a short font list
// (plain names that satisfy the brand-kit FONT rule) and tone chips (up to three).

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

const chip =
  'rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function PaletteSwatches({
  colours,
  onRemove,
}: {
  colours: string[];
  onRemove: (colour: string) => void;
}) {
  return (
    <ul aria-label="Palette" className="flex flex-wrap gap-2">
      {colours.map((c) => (
        <li
          key={c}
          className="flex items-center gap-2 rounded-lg border border-border py-1 pr-1 pl-1.5"
        >
          <span
            aria-hidden
            className="size-6 rounded-md border border-border"
            style={{ backgroundColor: c }}
          />
          <span className="font-mono text-xs">{c}</span>
          <button
            type="button"
            aria-label={`Remove ${c}`}
            onClick={() => onRemove(c)}
            className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3.5" />
          </button>
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
  return (
    <div role="radiogroup" aria-label="Font" className="flex flex-wrap gap-2">
      {FONTS.map((font) => (
        <button
          key={font}
          type="button"
          role="radio"
          aria-checked={value === font}
          onClick={() => onChange(font)}
          style={{ fontFamily: `'${font}', ui-sans-serif, system-ui` }}
          className={cn(
            chip,
            value === font
              ? 'border-foreground bg-foreground/[0.04]'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {font}
        </button>
      ))}
    </div>
  );
}

export function ToneChips({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tones: string[]) => void;
}) {
  const full = value.length >= MAX_TONES;
  return (
    <div role="group" aria-label="Tone" className="flex flex-wrap gap-2">
      {TONES.map((tone) => {
        const on = value.includes(tone);
        return (
          <button
            key={tone}
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            onClick={() => onChange(on ? value.filter((t) => t !== tone) : [...value, tone])}
            className={cn(
              chip,
              'disabled:opacity-40',
              on
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {tone}
          </button>
        );
      })}
    </div>
  );
}

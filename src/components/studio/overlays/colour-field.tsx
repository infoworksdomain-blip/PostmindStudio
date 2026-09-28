'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { joinHex, splitHex } from './colour';

// A colour picker with a transparency slider (13.7): #rrggbb from the native picker plus an
// opacity percentage, stored as #rrggbbaa when not fully opaque.

export function ColourField({
  id,
  value,
  fallback,
  disabled,
  onChange,
}: {
  id: string;
  value: string | null;
  fallback: string;
  disabled?: boolean;
  onChange: (hex: string) => void;
}) {
  const t = useTranslations('overlays.form');
  const f = useFormat();
  const { rgb, alpha } = splitHex(value, fallback);
  const percent = Math.round(alpha * 100);
  return (
    <span className="flex items-center gap-2">
      <input
        id={id}
        type="color"
        value={rgb}
        disabled={disabled}
        onChange={(e) => onChange(joinHex(e.target.value, alpha))}
        className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent disabled:opacity-40"
      />
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        disabled={disabled}
        aria-label={t('opacity')}
        onChange={(e) => onChange(joinHex(rgb, Number(e.target.value) / 100))}
        className="w-full min-w-0 accent-primary disabled:opacity-40"
      />
      <span className="tabular w-9 shrink-0 text-end text-xs text-muted-foreground">
        {f.percent(percent / 100)}
      </span>
    </span>
  );
}

'use client';

import { Clapperboard, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IconButton } from '@/components/ui/icon-button';
import { useApi } from '@/lib/client/api';
import { ChoiceChips } from '@/components/ui/choice-chips';
import type { Reference, ReferenceMode } from './body';

// A3.9 — shown when Create is opened from the reference library (?reference=<id>&mode=).

interface LibraryVideo {
  id: string;
  title: string;
  allowedModes: string[];
  durationSec: number;
}

const MODES: readonly ReferenceMode[] = ['INSPIRE', 'TEMPLATE'];

export function ReferenceBanner({
  reference,
  onModeChange,
  onClear,
}: {
  reference: Reference;
  onModeChange: (mode: ReferenceMode) => void;
  onClear: () => void;
}) {
  const t = useTranslations('create.reference');
  const { data, error } = useApi<{ video: LibraryVideo }>(`/library/videos/${reference.id}`);
  const video = data?.video;
  const allowed = video?.allowedModes;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center">
      <Clapperboard className="size-5 shrink-0 text-primary" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{t('eyebrow')}</p>
        <p className="truncate text-sm font-medium">
          {error ? t('unavailable') : (video?.title ?? t('loading'))}
        </p>
      </div>
      <ChoiceChips
        type="single"
        label={t('modesAria')}
        className="flex-nowrap"
        value={reference.mode}
        onChange={onModeChange}
        options={MODES.map((mode) => {
          const disabled = Boolean(allowed && !allowed.includes(mode));
          const hint = disabled ? t('modeNotAllowed') : t(`modes.${mode}.hint`);
          return {
            value: mode,
            disabled,
            description: hint,
            label: <span title={hint}>{t(`modes.${mode}.label`)}</span>,
          };
        })}
      />
      <IconButton label={t('clear')} onClick={onClear}>
        <X />
      </IconButton>
    </div>
  );
}

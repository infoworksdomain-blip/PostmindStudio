'use client';

import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { Reference, ReferenceMode } from './body';

// A3.9 — shown when Create is opened from the reference library (?reference=<id>&mode=).

interface LibraryVideo {
  id: string;
  title: string;
  allowedModes: string[];
  durationSec: number;
}

const MODES: Array<{ mode: ReferenceMode; label: string; hint: string }> = [
  { mode: 'INSPIRE', label: 'Inspire', hint: 'Borrow the mood and pacing' },
  { mode: 'TEMPLATE', label: 'Template', hint: 'Follow its structure shot by shot' },
];

export function ReferenceBanner({
  reference,
  onModeChange,
  onClear,
}: {
  reference: Reference;
  onModeChange: (mode: ReferenceMode) => void;
  onClear: () => void;
}) {
  const { data, error } = useApi<{ video: LibraryVideo }>(`/library/videos/${reference.id}`);
  const video = data?.video;
  const allowed = video?.allowedModes;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center">
      <Sparkles className="size-5 shrink-0 text-primary" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
          From the reference library
        </p>
        <p className="truncate text-sm font-medium">
          {error ? 'Reference video unavailable' : (video?.title ?? 'Loading reference…')}
        </p>
      </div>
      <div role="radiogroup" aria-label="Reference mode" className="flex gap-1.5">
        {MODES.map(({ mode, label, hint }) => {
          const disabled = Boolean(allowed && !allowed.includes(mode));
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={reference.mode === mode}
              disabled={disabled}
              title={disabled ? 'This video’s licence does not allow this mode' : hint}
              onClick={() => onModeChange(mode)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40',
                reference.mode === mode
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Don’t use a reference" onClick={onClear}>
        <X />
      </Button>
    </div>
  );
}

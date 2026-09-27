'use client';

import Link from 'next/link';
import { ArrowRight, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MODE_COPY, referenceHref } from './library-utils';
import type { ReferenceMode } from './types';

// A3.1 — "Use as reference": TEMPLATE (same video, my content) and INSPIRE (one like this).
// A mode the licence doesn't allow is shown but locked (scenario 3 is INSPIRE only).

const MODES: ReferenceMode[] = ['TEMPLATE', 'INSPIRE'];

export function UseReferencePanel({ id, allowedModes }: { id: string; allowedModes: string[] }) {
  return (
    <section aria-labelledby="use-reference" className="grid gap-2">
      <h2
        id="use-reference"
        className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
      >
        Use as reference
      </h2>
      {MODES.map((mode) => {
        const allowed = allowedModes.includes(mode);
        const copy = MODE_COPY[mode];
        const inner = (
          <>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{copy.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {allowed ? copy.body : 'Not available for this reference under its licence.'}
              </span>
            </span>
            {allowed ? (
              <ArrowRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
            ) : (
              <Lock className="size-4 shrink-0 text-muted-foreground" />
            )}
          </>
        );
        const className = cn(
          'group flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm',
          allowed
            ? 'border-border bg-card transition-colors hover:border-foreground/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            : 'border-dashed border-border opacity-70',
          allowed && mode === 'TEMPLATE' && 'border-primary/40 bg-primary/5',
        );
        return allowed ? (
          <Link key={mode} href={referenceHref(id, mode)} className={className}>
            {inner}
          </Link>
        ) : (
          <div key={mode} aria-disabled className={className}>
            {inner}
          </div>
        );
      })}
    </section>
  );
}

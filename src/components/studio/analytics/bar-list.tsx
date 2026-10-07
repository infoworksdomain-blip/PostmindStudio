'use client';

import type { ReactNode } from 'react';

// Ranked horizontal bars — breakdowns by platform, engagement type, provider, project and audience.
// Values are text (Geist Mono, tabular), so the list reads correctly without the bars; the bars
// are a quiet magnitude cue scaled to the largest row. Bar length encodes magnitude, the label
// carries identity, so every row wears one hue (25.11: no colour cycling by rank).

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
  hint?: string;
}

export function BarList({
  rows,
  label,
  empty,
  tone = 'var(--chart-1)',
}: {
  rows: BarRow[];
  label: string;
  empty: string;
  /** Bar colour (a chart token), default data teal. */
  tone?: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="grid gap-3.5">
      {rows.map((row) => (
        <li key={row.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="shrink-0 font-mono text-[0.8125rem] font-medium">
              {row.display}
              {row.hint && (
                <span className="ms-1.5 font-sans text-xs font-normal text-muted-foreground">
                  {row.hint}
                </span>
              )}
            </span>
          </div>
          <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (row.value / max) * 100)}%`,
                background: tone,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

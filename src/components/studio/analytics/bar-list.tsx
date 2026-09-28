'use client';

import type { ReactNode } from 'react';

// Ranked horizontal bars — breakdowns by platform, provider and project. Values are text, so
// the list reads correctly without the bars; the bars are decoration scaled to the largest row.

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
  hint?: string;
}

const TONES = ['var(--chart-1)', 'var(--chart-4)', 'var(--chart-3)', 'var(--chart-5)'];

export function BarList({
  rows,
  label,
  empty,
  tone,
}: {
  rows: BarRow[];
  label: string;
  empty: string;
  /** Fixed colour; by default rows cycle through the chart tokens. */
  tone?: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="grid gap-3">
      {rows.map((row, i) => (
        <li key={row.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="tabular shrink-0 font-medium">
              {row.display}
              {row.hint && (
                <span className="ms-1.5 text-xs font-normal text-muted-foreground">{row.hint}</span>
              )}
            </span>
          </div>
          <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (row.value / max) * 100)}%`,
                background: tone ?? TONES[i % TONES.length],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

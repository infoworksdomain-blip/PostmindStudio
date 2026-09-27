'use client';

import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { nearestIndex, plot } from './chart-utils';
import type { SeriesPoint } from './types';

// Small accessible area chart in plain SVG, coloured with the teal chart tokens. The plot
// stretches to its container (non-scaling strokes); axis labels are HTML so text never
// distorts. Keyboard: focus the chart and use ←/→/Home/End to read each point aloud. A hidden
// data table carries the full series for screen readers.

export interface AreaChartProps {
  points: SeriesPoint[];
  label: string;
  formatValue: (value: number) => string;
  /** CSS colour, default the first chart token. */
  color?: string;
  height?: number;
  /** Smallest axis ceiling (e.g. 100 pence so an idle spend chart reads £1.00, not £0.01). */
  minMax?: number;
  /** What each point is, for the keyboard hint and the screen-reader table (default "day"). */
  pointName?: string;
}

export function AreaChart({
  points,
  label,
  formatValue,
  color = 'var(--chart-1)',
  height = 200,
  minMax = 1,
  pointName = 'day',
}: AreaChartProps) {
  const gradientId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const { max, coords, line, area } = plot(points, minMax);
  const current = active !== null ? points[active] : undefined;
  const currentCoord = active !== null ? coords[active] : undefined;

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setActive(nearestIndex((e.clientX - rect.left) / rect.width, points.length));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    const last = points.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: Math.min(last, (active ?? -1) + 1),
      ArrowLeft: Math.max(0, (active ?? last + 1) - 1),
      Home: 0,
      End: last,
    };
    if (e.key in moves) {
      e.preventDefault();
      setActive(moves[e.key] ?? 0);
    }
  };

  const first = points[0];
  const middle = points[Math.floor(points.length / 2)];
  const final = points.at(-1);

  return (
    <figure className="m-0">
      <div className="grid grid-cols-[auto_1fr] gap-x-3">
        <div
          aria-hidden
          className="tabular flex flex-col justify-between text-right text-[0.7rem] text-muted-foreground"
          style={{ height }}
        >
          <span>{formatValue(max)}</span>
          <span>{formatValue(max / 2)}</span>
          <span>0</span>
        </div>
        <div
          ref={plotRef}
          role="img"
          tabIndex={0}
          aria-label={`${label}. Use arrow keys to read each ${pointName}.`}
          onPointerMove={onPointer}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          className="relative rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          style={{ height }}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
            aria-hidden
          >
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 50, 100].map((y) => (
              <line
                key={y}
                x1="0"
                x2="100"
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={y === 100 ? undefined : '2 3'}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {area && <path d={area} fill={`url(#${gradientId})`} />}
            {line && (
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {currentCoord && (
              <line
                x1={currentCoord.x}
                x2={currentCoord.x}
                y1="0"
                y2="100"
                stroke="var(--foreground)"
                strokeOpacity="0.35"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {current && currentCoord && (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                style={{
                  left: `${currentCoord.x}%`,
                  top: `${currentCoord.y}%`,
                  background: color,
                }}
              />
              <span
                className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background shadow"
                style={{ left: `${Math.min(88, Math.max(12, currentCoord.x))}%` }}
              >
                {current.label}: <strong className="tabular">{formatValue(current.value)}</strong>
              </span>
            </>
          )}
        </div>
        <span />
        <div aria-hidden className="mt-2 flex justify-between text-[0.7rem] text-muted-foreground">
          <span>{first?.label}</span>
          {points.length > 2 && <span>{middle?.label}</span>}
          {points.length > 1 && <span>{final?.label}</span>}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {current ? `${current.label}: ${formatValue(current.value)}` : ''}
      </p>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{pointName.charAt(0).toUpperCase() + pointName.slice(1)}</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td>{formatValue(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

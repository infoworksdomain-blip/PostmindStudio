'use client';

import { useCallback, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { nearestIndex, plot, shortDay } from './chart-utils';
import type { SeriesPoint } from './types';

// Small accessible area chart in plain SVG, coloured with the 25.2 chart tokens (data teal by
// default). The plot stretches to its container (non-scaling strokes); axis labels are HTML in
// Geist Mono so text never distorts. Marks follow the dataviz specs: a 2px line, a ~10% area wash,
// solid hairline gridlines, an 8px+ end dot with a surface ring. Hover or the keyboard (focus the
// chart, ←/→/Home/End) shows a crosshair and a tooltip in the shared Tooltip style, and a live
// region reads the point; a hidden data table carries the full series for screen readers.
//
// BACKLOG 16.2: the plot runs left to right in every locale (time reads left to right, as in
// video tools), so the chart grid is pinned to dir="ltr"; its labels come from the catalogue and
// the caller's locale-aware formatters.

/** '2026-09-27' → the active locale's short day ('27 Sept', 'Sep 27', '9月27日'). */
export function useShortDay(): (day: string) => string {
  const locale = useLocale();
  return useCallback((day: string) => shortDay(day, locale), [locale]);
}

/** What each point of a series is: a calendar day, or a position through the video. */
export type ChartPointKind = 'day' | 'position';

export interface AreaChartProps {
  points: SeriesPoint[];
  label: string;
  formatValue: (value: number) => string;
  /** CSS colour, default the first chart token. */
  color?: string;
  height?: number;
  /** Smallest axis ceiling (e.g. 100 pence so an idle spend chart reads £1.00, not £0.01). */
  minMax?: number;
  /** What each point is, for the keyboard hint and the screen-reader table (default day). */
  pointKind?: ChartPointKind;
}

const TOOLTIP_CLASS =
  'pointer-events-none absolute -top-2 z-(--z-raised) -translate-x-1/2 -translate-y-full rounded-control bg-foreground px-2 py-1 text-xs font-medium whitespace-nowrap text-background shadow-overlay';

function useKeyboardReading(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const last = count - 1;
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
  return { active, setActive, onKey };
}

function Gridlines() {
  return (
    <>
      {[0, 50, 100].map((y) => (
        <line
          key={y}
          x1="0"
          x2="100"
          y1={y}
          y2={y}
          stroke={y === 100 ? 'var(--border-strong)' : 'var(--border)'}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

function Dot({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
      style={{ left: `${x}%`, top: `${y}%`, background: color }}
    />
  );
}

export function AreaChart({
  points,
  label,
  formatValue,
  color = 'var(--chart-1)',
  height = 200,
  minMax = 1,
  pointKind = 'day',
}: AreaChartProps) {
  const t = useTranslations('analytics.chart');
  const gradientId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const { active, setActive, onKey } = useKeyboardReading(points.length);
  const { max, coords, line, area } = plot(points, minMax);
  const current = active !== null ? points[active] : undefined;
  const currentCoord = active !== null ? coords[active] : undefined;
  const endCoord = coords.at(-1);

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setActive(nearestIndex((e.clientX - rect.left) / rect.width, points.length));
  };

  const first = points[0];
  const middle = points[Math.floor(points.length / 2)];
  const final = points.at(-1);

  return (
    <figure className="m-0">
      <div dir="ltr" className="grid grid-cols-[auto_1fr] gap-x-3">
        <div
          aria-hidden
          className="flex flex-col justify-between text-end font-mono text-[0.6875rem] text-muted-foreground"
          style={{ height }}
        >
          <span className="-translate-y-1/2">{formatValue(max)}</span>
          <span>{formatValue(max / 2)}</span>
          <span className="translate-y-1/2">{formatValue(0)}</span>
        </div>
        <div
          ref={plotRef}
          role="img"
          tabIndex={0}
          aria-label={t(`keyboardHint.${pointKind}`, { label })}
          onPointerMove={onPointer}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          className="relative cursor-crosshair rounded-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
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
                <stop offset="0%" stopColor={color} stopOpacity="0.16" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <Gridlines />
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
                strokeOpacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {!current && endCoord && <Dot x={endCoord.x} y={endCoord.y} color={color} />}
          {current && currentCoord && (
            <>
              <Dot x={currentCoord.x} y={currentCoord.y} color={color} />
              <span
                dir="auto"
                className={TOOLTIP_CLASS}
                style={{ left: `${Math.min(88, Math.max(12, currentCoord.x))}%` }}
              >
                {t.rich('point', {
                  label: current.label,
                  value: formatValue(current.value),
                  b: (chunks) => <strong className="font-mono font-semibold">{chunks}</strong>,
                })}
              </span>
            </>
          )}
        </div>
        <span />
        <div
          aria-hidden
          className="mt-2 flex justify-between font-mono text-[0.6875rem] text-muted-foreground"
        >
          <span>{first?.label}</span>
          {points.length > 2 && <span>{middle?.label}</span>}
          {points.length > 1 && <span>{final?.label}</span>}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {current
          ? t.rich('point', {
              label: current.label,
              value: formatValue(current.value),
              b: (chunks) => chunks,
            })
          : ''}
      </p>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t(`column.${pointKind}`)}</th>
            <th scope="col">{t('column.value')}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={`${p.label}-${i}`}>
              <td>{p.label}</td>
              <td>{formatValue(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

'use client';

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import { moveTiming, resizeTiming, type Timing } from './overlay-math';
import type { Overlay } from './types';

// A4.7 mini-timeline: the shot's duration with one bar per overlay. Drag a bar to move it, drag
// an end to change its duration. Keyboard: ←/→ move the focused bar 0.1s (Shift: 0.5s);
// Alt+←/→ change its end. Changes are local drafts until saved.

type DragMode = 'move' | 'start' | 'end';

interface Drag {
  id: string;
  mode: DragMode;
  originX: number;
  origin: Timing;
}

export function OverlayTimeline({
  overlays,
  duration,
  playhead,
  selectedId,
  onSelect,
  onTiming,
  onSeek,
  disabled,
  unit = 'shot',
}: {
  overlays: Overlay[];
  duration: number;
  playhead: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTiming: (id: string, timing: Timing) => void;
  onSeek: (sec: number) => void;
  disabled?: boolean;
  /** What the timeline spans ("shot", "slide", "video"), for the empty state. */
  unit?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const safeDuration = duration > 0 ? duration : 1;
  const pct = (sec: number) => `${(sec / safeDuration) * 100}%`;
  const ticks = Array.from({ length: Math.floor(safeDuration) + 1 }, (_, i) => i);

  function secPerPx(): number {
    const width = track.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? safeDuration / width : 0;
  }

  function startDrag(e: PointerEvent<HTMLElement>, overlay: Overlay, mode: DragMode) {
    if (disabled) return;
    e.stopPropagation();
    onSelect(overlay.id);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: overlay.id, mode, originX: e.clientX, origin: overlay };
  }

  function moveDrag(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const delta = (e.clientX - d.originX) * secPerPx();
    const timing =
      d.mode === 'move'
        ? moveTiming(d.origin, delta, safeDuration)
        : resizeTiming(d.origin, d.mode, delta, safeDuration);
    onTiming(d.id, timing);
  }

  function endDrag() {
    drag.current = null;
  }

  function onKey(e: KeyboardEvent, overlay: Overlay) {
    if (disabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.5 : 0.1);
    onTiming(
      overlay.id,
      e.altKey
        ? resizeTiming(overlay, 'end', step, safeDuration)
        : moveTiming(overlay, step, safeDuration),
    );
  }

  function seek(e: PointerEvent<HTMLDivElement>) {
    const box = track.current?.getBoundingClientRect();
    if (!box?.width) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    onSeek(Math.round(ratio * safeDuration * 10) / 10);
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={track}
        onPointerDown={seek}
        className="relative h-5 cursor-pointer border-b border-border"
        aria-hidden
      >
        {ticks.map((t) => (
          <span
            key={t}
            className="tabular absolute bottom-0 -translate-x-1/2 text-[0.6rem] text-muted-foreground"
            style={{ left: pct(t) }}
          >
            {t}s
          </span>
        ))}
      </div>
      <div className="relative flex flex-col gap-1 py-1">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
          style={{ left: pct(playhead) }}
        />
        {overlays.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">No overlays on this {unit} yet.</p>
        )}
        {overlays.map((o) => {
          const selected = o.id === selectedId;
          return (
            <div key={o.id} className="relative h-8 rounded bg-muted/50">
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Overlay “${o.text}”, ${o.startAtSec.toFixed(1)}s to ${o.endAtSec.toFixed(1)}s`}
                aria-describedby="overlay-timeline-help"
                onClick={() => onSelect(o.id)}
                onKeyDown={(e) => onKey(e, o)}
                onPointerDown={(e) => startDrag(e, o, 'move')}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={cn(
                  'absolute inset-y-0 flex touch-none items-center overflow-hidden rounded border px-2 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card hover:border-foreground/40',
                  disabled ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
                )}
                style={{ left: pct(o.startAtSec), width: pct(o.endAtSec - o.startAtSec) }}
              >
                {!disabled && (
                  <span
                    aria-hidden
                    onPointerDown={(e) => startDrag(e, o, 'start')}
                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-foreground/10"
                  />
                )}
                <span className="truncate">{o.text}</span>
                {!disabled && (
                  <span
                    aria-hidden
                    onPointerDown={(e) => startDrag(e, o, 'end')}
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-foreground/10"
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <p id="overlay-timeline-help" className="text-[0.7rem] text-muted-foreground">
        Drag a bar or its ends. Keyboard: ←/→ move 0.1s (Shift 0.5s), Alt+←/→ change the end.
      </p>
    </div>
  );
}

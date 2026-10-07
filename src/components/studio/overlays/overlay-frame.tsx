'use client';

import { useTranslations } from 'next-intl';
import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { GUIDES, isActiveAt, snapAnchor } from './overlay-math';
import { resizedFontPct, steppedFontPct } from './resize-math';
import { useSafeAreaLabel } from './safe-area-label';
import type { SafeArea } from './safe-areas';
import type { Overlay } from './types';

// WYSIWYG layout preview (A4.7): HTML text over a frame of the variant's aspect ratio, showing
// the overlays live at the playhead, with rule-of-thirds guides. Clicking the frame places the
// selected overlay (snapping to the guides). The exact render comes from "Preview render".
// 13.7: the selected overlay has a corner handle that resizes it (drag, or arrow keys), and the
// platform's safe area is outlined (safe-areas.ts says which guides are official).

const ASPECT: Record<string, string> = {
  '9:16': '9 / 16',
  '16:9': '16 / 9',
  '1:1': '1 / 1',
  '4:5': '4 / 5',
};

const loadedFonts = new Set<string>();

/** Load a Google Fonts family on demand (A4.7 font loading). */
export function useGoogleFont(family: string) {
  useEffect(() => {
    const name = family.trim();
    if (!/^[A-Za-z0-9 -]{1,64}$/.test(name) || loadedFonts.has(name)) return;
    loadedFonts.add(name);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:wght@100..900&display=swap`;
    document.head.appendChild(link);
  }, [family]);
}

export function overlayCss(o: Overlay): CSSProperties {
  const hasBox = o.backgroundType === 'box' || o.backgroundType === 'rounded_box';
  const shadow =
    o.shadowColor && o.shadowBlurPx !== null
      ? `${o.shadowOffsetXPx ?? 0}px ${o.shadowOffsetYPx ?? 0}px ${o.shadowBlurPx}px ${o.shadowColor}`
      : undefined;
  return {
    left: `${o.anchorX * 100}%`,
    top: `${o.anchorY * 100}%`,
    transform: `translate(-50%, -50%) rotate(${o.rotationDeg}deg)`,
    fontFamily: `'${o.fontFamily}', sans-serif`,
    fontWeight: o.fontWeight,
    fontStyle: o.fontItalic ? 'italic' : 'normal',
    fontSize: `${o.fontSizePct}cqh`,
    lineHeight: o.lineHeight ?? 1.15,
    letterSpacing: o.letterSpacing ? `${o.letterSpacing}px` : undefined,
    color: o.fillColor,
    textAlign: o.alignment as CSSProperties['textAlign'],
    textShadow: shadow,
    WebkitTextStroke:
      o.strokeColor && o.strokeWidthPx ? `${o.strokeWidthPx / 2}px ${o.strokeColor}` : undefined,
    backgroundColor: hasBox ? (o.backgroundColor ?? undefined) : undefined,
    backgroundImage:
      o.backgroundType === 'gradient' && o.backgroundColor
        ? `linear-gradient(transparent, ${o.backgroundColor})`
        : undefined,
    backdropFilter: o.backgroundType === 'blur' ? 'blur(8px)' : undefined,
    padding: o.backgroundType === 'none' ? 0 : `${(o.backgroundPaddingPx ?? 12) / 4}px`,
    borderRadius:
      o.backgroundType === 'rounded_box' ? `${Math.min(o.backgroundRadiusPx ?? 12, 999)}px` : 0,
  };
}

function ResizeHandle({
  overlay,
  onResize,
}: {
  overlay: Overlay;
  onResize: (fontSizePct: number) => void;
}) {
  const t = useTranslations('overlays.frame');
  const start = useRef<{ x: number; y: number; pct: number; height: number } | null>(null);

  function down(e: PointerEvent<HTMLButtonElement>) {
    e.stopPropagation();
    e.preventDefault();
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    start.current = {
      x: e.clientX,
      y: e.clientY,
      pct: overlay.fontSizePct,
      height: box?.height ?? 0,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e: PointerEvent<HTMLButtonElement>) {
    const s = start.current;
    if (!s) return;
    onResize(resizedFontPct(s.pct, s.height, e.clientX - s.x, e.clientY - s.y));
  }
  function up(e: PointerEvent<HTMLButtonElement>) {
    start.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }
  function key(e: KeyboardEvent<HTMLButtonElement>) {
    const next = steppedFontPct(overlay.fontSizePct, e.key);
    if (next === null) return;
    e.preventDefault();
    onResize(next);
  }

  // The handle sits on the frame's bottom-right corner in every interface direction: the frame is
  // the video frame, and resize-math reads the drag physically.
  return (
    <button
      type="button"
      aria-label={t('resizeAria', { pct: overlay.fontSizePct })}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={key}
      className="pointer-events-auto absolute -right-2 -bottom-2 size-3.5 cursor-nwse-resize rounded-sm border border-background bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" // i18n-physical-ok
    />
  );
}

function OverlayText({
  overlay,
  selected,
  onResize,
}: {
  overlay: Overlay;
  selected: boolean;
  onResize?: (fontSizePct: number) => void;
}) {
  useGoogleFont(overlay.fontFamily);
  return (
    <span
      className={cn(
        'pointer-events-none absolute max-w-[90%] whitespace-pre-wrap',
        selected && 'outline-2 outline-offset-2 outline-primary outline-dashed',
      )}
      style={overlayCss(overlay)}
    >
      {overlay.text}
      {selected && onResize && <ResizeHandle overlay={overlay} onResize={onResize} />}
    </span>
  );
}

const pct = (fraction: number) => `${Math.round(fraction * 10_000) / 100}%`;

function SafeAreaGuide({ area }: { area: SafeArea }) {
  const safeAreaLabel = useSafeAreaLabel();
  return (
    <span
      aria-hidden
      title={safeAreaLabel(area)}
      data-testid="safe-area"
      className={cn(
        'pointer-events-none absolute border',
        area.official ? 'border-success/70' : 'border-dashed border-warning/70',
      )}
      style={{
        top: pct(area.top),
        bottom: pct(area.bottom),
        left: pct(area.left),
        right: pct(area.right),
      }}
    />
  );
}

export function OverlayFrame({
  overlays,
  aspectRatio,
  playhead,
  selectedId,
  onPlace,
  onResize,
  safeArea,
}: {
  overlays: Overlay[];
  aspectRatio: string;
  playhead: number;
  selectedId: string | null;
  onPlace?: (anchor: { anchorX: number; anchorY: number }) => void;
  /** 13.7: resize the selected overlay (font size, % of frame height). */
  onResize?: (fontSizePct: number) => void;
  /** 13.7: the target platform's safe area. */
  safeArea?: SafeArea | null;
}) {
  const t = useTranslations('overlays.frame');
  const f = useFormat();
  const visible = overlays.filter((o) => isActiveAt(o, playhead));

  function place(e: MouseEvent<HTMLDivElement>) {
    if (!onPlace || !selectedId) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    onPlace({
      anchorX: snapAnchor((e.clientX - box.left) / box.width),
      anchorY: snapAnchor((e.clientY - box.top) / box.height),
    });
  }

  return (
    <div
      role="img"
      aria-label={t('aria', {
        time: f.number(playhead, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        texts: visible.map((o) => o.text).join(', ') || t('noOverlays'),
      })}
      onClick={place}
      className={cn(
        'relative mx-auto w-full overflow-hidden rounded-lg bg-[linear-gradient(135deg,var(--foreground),color-mix(in_oklch,var(--foreground),var(--primary)_35%))]',
        aspectRatio === '16:9' ? 'max-w-full' : 'max-w-[20rem]',
        onPlace && selectedId && 'cursor-crosshair',
      )}
      style={{ aspectRatio: ASPECT[aspectRatio] ?? '9 / 16', containerType: 'size' }}
    >
      {GUIDES.map((g) => (
        <span
          key={`v${g}`}
          aria-hidden
          className="absolute inset-y-0 w-px bg-background/15"
          style={{ left: `${g * 100}%` }}
        />
      ))}
      {GUIDES.map((g) => (
        <span
          key={`h${g}`}
          aria-hidden
          className="absolute inset-x-0 h-px bg-background/15"
          style={{ top: `${g * 100}%` }}
        />
      ))}
      {safeArea && <SafeAreaGuide area={safeArea} />}
      {visible.map((o) => (
        <OverlayText
          key={o.id}
          overlay={o}
          selected={o.id === selectedId}
          onResize={o.id === selectedId ? onResize : undefined}
        />
      ))}
    </div>
  );
}

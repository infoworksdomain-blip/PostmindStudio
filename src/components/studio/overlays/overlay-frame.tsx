'use client';

import { useEffect, type CSSProperties, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { GUIDES, isActiveAt, snapAnchor } from './overlay-math';
import type { Overlay } from './types';

// WYSIWYG layout preview (A4.7): HTML text over a frame of the variant's aspect ratio, showing
// the overlays live at the playhead, with rule-of-thirds guides. Clicking the frame places the
// selected overlay (snapping to the guides). The exact render comes from "Preview render".

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

function OverlayText({ overlay, selected }: { overlay: Overlay; selected: boolean }) {
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
    </span>
  );
}

export function OverlayFrame({
  overlays,
  aspectRatio,
  playhead,
  selectedId,
  onPlace,
}: {
  overlays: Overlay[];
  aspectRatio: string;
  playhead: number;
  selectedId: string | null;
  onPlace?: (anchor: { anchorX: number; anchorY: number }) => void;
}) {
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
      aria-label={`Frame at ${playhead.toFixed(1)}s: ${visible.map((o) => o.text).join(', ') || 'no overlays'}`}
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
      {visible.map((o) => (
        <OverlayText key={o.id} overlay={o} selected={o.id === selectedId} />
      ))}
    </div>
  );
}

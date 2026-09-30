import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Phase 20.8 — small original line drawings for the empty states (no stock art, nothing to
// license): ink strokes in the muted foreground, one vermilion accent, a paper card behind. They
// are decorative (aria-hidden); the empty state's title and text say what is missing. Drawn on a
// 160×112 grid so they sit at the same size everywhere.

export type IllustrationName =
  | 'projects'
  | 'publications'
  | 'library'
  | 'images'
  | 'brand'
  | 'voice'
  | 'connections'
  | 'business'
  | 'approvals'
  | 'templates'
  | 'memory';

const ACCENT = 'fill-primary/85 stroke-none';

/** A 9:16 "phone" frame used by several drawings. */
function Phone({ x, y, children }: { x: number; y: number; children?: ReactNode }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="40" height="72" rx="7" className="fill-background" />
      <rect x="15" y="4" width="10" height="2" rx="1" />
      {children}
    </g>
  );
}

const DRAWINGS: Record<IllustrationName, ReactNode> = {
  projects: (
    <>
      <path d="M28 44h58v44H28z" className="fill-background" />
      <path d="M28 34l56-8 2 10-56 8z" className="fill-background" />
      <path d="M38 32.5l4 9M50 30.8l4 9M62 29l4 9M74 27.4l4 9" />
      <path d="M40 60h34M40 70h22" />
      <Phone x={96} y={24}>
        <path d="M8 16h24v34H8z" />
        <path d="M17 28l8 5-8 5z" className={ACCENT} />
        <path d="M8 58h16" />
      </Phone>
    </>
  ),
  publications: (
    <>
      <rect x="24" y="26" width="72" height="62" rx="6" className="fill-background" />
      <path d="M24 40h72M40 20v12M80 20v12" />
      {[0, 1, 2].map((r) =>
        [0, 1, 2, 3].map((c) => (
          <rect
            key={`${r}${c}`}
            x={32 + c * 15}
            y={48 + r * 12}
            width="9"
            height="6"
            rx="1.5"
            className={r === 1 && c === 2 ? ACCENT : undefined}
          />
        )),
      )}
      <path d="M104 62l38-18-12 40-9-13z" className="fill-background" />
      <path d="M121 71l21-27" />
    </>
  ),
  library: (
    <>
      <rect x="20" y="24" width="120" height="64" rx="6" className="fill-background" />
      <path d="M20 36h120M20 76h120" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <g key={i}>
          <rect x={27 + i * 14.5} y="28" width="6" height="4" rx="1" />
          <rect x={27 + i * 14.5} y="80" width="6" height="4" rx="1" />
        </g>
      ))}
      <rect x="30" y="42" width="30" height="28" rx="3" />
      <rect x="65" y="42" width="30" height="28" rx="3" />
      <rect x="100" y="42" width="30" height="28" rx="3" />
      <path d="M76 50l10 6-10 6z" className={ACCENT} />
    </>
  ),
  images: (
    <>
      <rect
        x="44"
        y="18"
        width="76"
        height="58"
        rx="5"
        transform="rotate(8 82 47)"
        className="fill-background"
      />
      <rect x="32" y="30" width="80" height="62" rx="5" className="fill-background" />
      <circle cx="94" cy="46" r="6" className={ACCENT} />
      <path d="M38 86l22-26 16 16 10-10 20 20" />
    </>
  ),
  brand: (
    <>
      <path
        d="M80 20c-30 0-52 18-52 40 0 14 10 26 26 26 8 0 8-10 16-10 10 0 12 10 22 10 16 0 40-8 40-30 0-20-22-36-52-36z"
        className="fill-background"
      />
      <circle cx="52" cy="54" r="7" className={ACCENT} />
      <circle cx="70" cy="38" r="7" />
      <circle cx="94" cy="38" r="7" />
      <circle cx="112" cy="54" r="7" />
      <path d="M126 88l16-44" />
      <path d="M142 44l-4 12" />
    </>
  ),
  voice: (
    <>
      <rect x="24" y="30" width="112" height="52" rx="26" className="fill-background" />
      {[8, 18, 28, 14, 34, 22, 12, 30, 20, 10, 24, 16].map((h, i) => (
        <path
          key={i}
          d={`M${40 + i * 7} ${56 - h / 2}v${h}`}
          className={i === 4 ? 'stroke-primary' : undefined}
        />
      ))}
    </>
  ),
  connections: (
    <>
      <rect x="18" y="42" width="44" height="28" rx="8" className="fill-background" />
      <path d="M62 50h10M62 62h10" />
      <rect x="98" y="42" width="44" height="28" rx="8" className="fill-background" />
      <path d="M88 56h10" />
      <path d="M72 46v20" />
      <circle cx="80" cy="56" r="4" className={ACCENT} />
      <path d="M30 56h20M110 56h20" />
    </>
  ),
  business: (
    <>
      <path d="M30 50h100v40H30z" className="fill-background" />
      <path d="M26 36h108l-4 14H30z" className="fill-background" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <path key={i} d={`M${30 + i * 16.7} 36l-2 14`} />
      ))}
      <rect x="40" y="60" width="34" height="22" rx="2" />
      <rect x="88" y="60" width="24" height="30" rx="2" />
      <ellipse cx="57" cy="76" rx="9" ry="5" className={ACCENT} />
    </>
  ),
  approvals: (
    <>
      <rect x="36" y="18" width="64" height="80" rx="6" className="fill-background" />
      <path d="M48 34h40M48 46h40M48 58h26" />
      <circle cx="106" cy="76" r="20" className="fill-background" />
      <path d="M96 76l7 7 13-14" className="stroke-primary" />
    </>
  ),
  templates: (
    <>
      <rect x="52" y="16" width="56" height="44" rx="5" className="fill-background" />
      <rect x="44" y="30" width="72" height="44" rx="5" className="fill-background" />
      <rect x="34" y="46" width="92" height="50" rx="5" className="fill-background" />
      <rect x="42" y="54" width="30" height="34" rx="3" />
      <path d="M80 58h36M80 68h28M80 78h20" />
      <rect x="47" y="78" width="20" height="5" rx="2" className={ACCENT} />
    </>
  ),
  memory: (
    <>
      <rect x="30" y="22" width="100" height="70" rx="6" className="fill-background" />
      <path d="M42 38h52M42 50h76M42 62h64M42 74h40" />
      <path d="M112 34l4 8 8 1-6 6 2 8-8-4-8 4 2-8-6-6 8-1z" className={ACCENT} />
    </>
  ),
};

export function EmptyIllustration({
  name,
  className,
}: {
  name: IllustrationName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 160 112"
      width="160"
      height="112"
      data-illustration={name}
      className={cn(
        'h-28 w-40 fill-none stroke-muted-foreground stroke-[1.75] [stroke-linecap:round] [stroke-linejoin:round]',
        className,
      )}
    >
      <ellipse cx="80" cy="100" rx="62" ry="6" className="fill-muted stroke-none" />
      {DRAWINGS[name]}
    </svg>
  );
}

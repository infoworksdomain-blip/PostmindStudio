import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Phase 18 landing page — sample "renders" drawn in CSS (no stock images to license or load):
// layered gradients that read as a bakery counter, a street at dusk, a studio flat-lay and so on,
// with the caption chip and safe-area guides a Studio render carries. Decorative: the caption is
// real text, the scene itself is aria-hidden.

export type Scene = 'counter' | 'dusk' | 'flatlay' | 'workshop' | 'market' | 'studio';

const SCENES: Record<Scene, string> = {
  counter:
    'radial-gradient(120% 70% at 30% 20%, oklch(0.9 0.08 75) 0%, transparent 55%),' +
    'radial-gradient(90% 60% at 80% 85%, oklch(0.62 0.16 45) 0%, transparent 60%),' +
    'linear-gradient(170deg, oklch(0.78 0.1 70), oklch(0.45 0.09 40))',
  dusk:
    'radial-gradient(80% 50% at 70% 25%, oklch(0.85 0.13 60) 0%, transparent 60%),' +
    'linear-gradient(180deg, oklch(0.42 0.08 280) 0%, oklch(0.55 0.14 25) 55%, oklch(0.25 0.03 260) 100%)',
  flatlay:
    'radial-gradient(35% 25% at 30% 35%, oklch(0.95 0.02 90) 0 60%, transparent 62%),' +
    'radial-gradient(28% 20% at 70% 62%, oklch(0.7 0.14 35) 0 60%, transparent 62%),' +
    'linear-gradient(135deg, oklch(0.86 0.04 180), oklch(0.72 0.06 200))',
  workshop:
    'radial-gradient(70% 55% at 25% 30%, oklch(0.82 0.1 85) 0%, transparent 60%),' +
    'linear-gradient(160deg, oklch(0.5 0.06 150), oklch(0.3 0.04 170))',
  market:
    'repeating-linear-gradient(90deg, oklch(0.75 0.14 30) 0 14%, oklch(0.93 0.03 85) 14% 28%),' +
    'linear-gradient(180deg, transparent 45%, oklch(0.35 0.05 60) 45%)',
  studio:
    'radial-gradient(60% 45% at 50% 38%, oklch(0.93 0.02 80) 0%, transparent 70%),' +
    'linear-gradient(180deg, oklch(0.3 0.02 60), oklch(0.18 0.01 60))',
};

export function SceneFrame({
  scene,
  caption,
  label,
  ratio = '9/16',
  className,
  children,
}: {
  scene: Scene;
  caption?: string;
  label?: string;
  ratio?: '9/16' | '1/1' | '16/9' | '4/5';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <figure
      className={cn(
        'relative overflow-hidden rounded-[1.1rem] bg-foreground shadow-[0_30px_60px_-30px_rgb(40_20_10/0.55)] ring-1 ring-black/10',
        className,
      )}
      style={{ aspectRatio: ratio }}
    >
      <div aria-hidden className="absolute inset-0" style={{ background: SCENES[scene] }} />
      {/* Safe-area guides, as in the review screen's frame overlay. */}
      <div
        aria-hidden
        className="absolute inset-x-[7%] inset-y-[9%] rounded-md border border-white/25 border-dashed"
      />
      {label && (
        <span className="absolute start-3 top-3 rounded-full bg-black/45 px-2 py-0.5 text-[0.65rem] font-medium tracking-wide text-white backdrop-blur">
          {label}
        </span>
      )}
      {caption && (
        <figcaption className="absolute inset-x-[9%] bottom-[12%] text-center">
          <span className="box-decoration-clone rounded bg-white px-1.5 py-0.5 text-[0.8rem] leading-relaxed font-semibold text-foreground shadow">
            {caption}
          </span>
        </figcaption>
      )}
      {children}
    </figure>
  );
}

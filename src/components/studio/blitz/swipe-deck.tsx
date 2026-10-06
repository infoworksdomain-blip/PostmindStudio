'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, PencilLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { directionOf } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import {
  exitSign,
  keyOutcome,
  swipeOutcome,
  swipeProgress,
  tiltFor,
  type Direction,
} from './blitz-model';

// 22.4 — the Blitz card stack: one card at a time with the next two behind it (depth), dragged
// with pointer events (spring back under the threshold, fly off with a tilt past it, KEEP / SKIP
// stamps that fade in with the drag), buttons, and keys (→ keep, ← skip, ↑ edit first; mirrored
// in right-to-left languages, like the drag). Reduced motion: no tilt, no fly-off, instant.

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

export interface DeckItem {
  id: string;
  /** What the card is, for screen readers ("Carousel: 3 reasons your sourdough is flat"). */
  label: string;
}

export interface SwipeDeckProps<T extends DeckItem> {
  items: readonly T[];
  renderCard: (item: T, active: boolean) => ReactNode;
  onKeep: (item: T) => void;
  onSkip: (item: T) => void;
  onEdit?: (item: T) => void;
  editLabel?: string;
  busy?: boolean;
  /** Under the buttons (e.g. the skip-reason chips). */
  footer?: ReactNode;
}

const EXIT_MS = 260;

export function SwipeDeck<T extends DeckItem>({
  items,
  renderCard,
  onKeep,
  onSkip,
  onEdit,
  editLabel,
  busy = false,
  footer,
}: SwipeDeckProps<T>) {
  const t = useTranslations('blitz.deck');
  const dir: Direction = directionOf(useLocale()) === 'rtl' ? 'rtl' : 'ltr';
  const reduced = usePrefersReducedMotion();
  const [drag, setDrag] = useState<{ dx: number; dy: number; active: boolean }>({
    dx: 0,
    dy: 0,
    active: false,
  });
  const [exiting, setExiting] = useState<{ id: string; sign: 1 | -1 } | null>(null);
  const start = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const top = items[0];

  useEffect(() => {
    setDrag({ dx: 0, dy: 0, active: false });
    setExiting(null);
  }, [top?.id]);

  const decide = useCallback(
    (outcome: 'keep' | 'skip') => {
      if (!top || busy || exiting) return;
      const run = () => {
        // If the card is still on top afterwards (e.g. the keep dialog was cancelled) it comes
        // back; a card the parent removed is replaced by the next one anyway.
        setExiting(null);
        setDrag({ dx: 0, dy: 0, active: false });
        if (outcome === 'keep') onKeep(top);
        else onSkip(top);
      };
      if (reduced) return run();
      setExiting({ id: top.id, sign: exitSign(outcome, dir) });
      window.setTimeout(run, EXIT_MS);
    },
    [top, busy, exiting, onKeep, onSkip, reduced, dir],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (busy || exiting || e.button > 0) return;
    start.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ dx: 0, dy: 0, active: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.pointer !== e.pointerId) return;
    setDrag({ dx: e.clientX - start.current.x, dy: e.clientY - start.current.y, active: true });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.pointer !== e.pointerId) return;
    const dx = e.clientX - start.current.x;
    start.current = null;
    const outcome = swipeOutcome(dx, dir);
    if (outcome) {
      setDrag((d) => ({ ...d, active: false }));
      decide(outcome);
    } else setDrag({ dx: 0, dy: 0, active: false });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const outcome = keyOutcome(e.key, dir);
    if (!outcome || !top) return;
    e.preventDefault();
    if (outcome === 'edit') onEdit?.(top);
    else decide(outcome);
  };

  // Which stamp shows, from the drag in screen terms.
  const forward = dir === 'rtl' ? -drag.dx : drag.dx;
  const progress = swipeProgress(drag.dx);
  const transform = (() => {
    if (exiting) {
      const x = exiting.sign * 140;
      return reduced ? 'none' : `translate3d(${x}%, 4%, 0) rotate(${exiting.sign * 20}deg)`;
    }
    if (!drag.active && drag.dx === 0) return 'none';
    const tilt = reduced ? 0 : tiltFor(drag.dx);
    return `translate3d(${drag.dx}px, ${drag.dy * 0.25}px, 0) rotate(${tilt}deg)`;
  })();

  return (
    <div className="flex flex-col items-center gap-5">
      <div
        role="group"
        aria-roledescription={t('roleDeck')}
        aria-label={top ? top.label : t('empty')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="relative aspect-[9/16] max-h-[calc(100dvh-14rem)] w-full max-w-[22rem] rounded-[1.75rem] outline-none focus-visible:ring-4 focus-visible:ring-ring/60 sm:max-w-[24rem]"
      >
        {items
          .slice(0, 3)
          .map((item, depth) => {
            const isTop = depth === 0;
            return (
              <div
                key={item.id}
                aria-hidden={!isTop}
                data-testid={isTop ? 'blitz-top-card' : undefined}
                onPointerDown={isTop ? onPointerDown : undefined}
                onPointerMove={isTop ? onPointerMove : undefined}
                onPointerUp={isTop ? onPointerUp : undefined}
                onPointerCancel={isTop ? onPointerUp : undefined}
                style={
                  isTop
                    ? {
                        transform,
                        transition: drag.active
                          ? 'none'
                          : `transform ${exiting ? EXIT_MS : 420}ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity ${EXIT_MS}ms ease`,
                        opacity: exiting ? 0 : 1,
                        zIndex: 30,
                        touchAction: 'pan-y',
                      }
                    : {
                        transform: reduced
                          ? 'none'
                          : `translateY(${depth * 14}px) scale(${1 - depth * 0.045})`,
                        zIndex: 30 - depth * 10,
                        transition: 'transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                        filter: `brightness(${1 - depth * 0.08})`,
                      }
                }
                className={cn(
                  'absolute inset-0 overflow-hidden rounded-[1.75rem] border border-border/70 bg-card shadow-[0_24px_60px_-28px_rgba(15,23,42,0.55)] select-none',
                  isTop && 'cursor-grab active:cursor-grabbing',
                )}
              >
                {renderCard(item, isTop && !exiting)}
                {isTop && (
                  <>
                    <Stamp
                      kind="keep"
                      label={t('stampKeep')}
                      opacity={
                        forward > 0
                          ? progress
                          : exiting && exiting.sign === exitSign('keep', dir)
                            ? 1
                            : 0
                      }
                    />
                    <Stamp
                      kind="skip"
                      label={t('stampSkip')}
                      opacity={
                        forward < 0
                          ? progress
                          : exiting && exiting.sign === exitSign('skip', dir)
                            ? 1
                            : 0
                      }
                    />
                  </>
                )}
              </div>
            );
          })
          .reverse()}
      </div>

      <div
        className="flex items-center justify-center gap-4"
        role="toolbar"
        aria-label={t('actions')}
      >
        <RoundButton
          tone="skip"
          label={t('skipLabel')}
          disabled={!top || busy}
          onClick={() => decide('skip')}
        >
          <X className="size-7" strokeWidth={2.5} />
        </RoundButton>
        {onEdit && (
          <RoundButton
            tone="edit"
            label={editLabel ?? t('editLabel')}
            disabled={!top || busy}
            onClick={() => top && onEdit(top)}
            small
          >
            <PencilLine className="size-5" />
          </RoundButton>
        )}
        <RoundButton
          tone="keep"
          label={t('keepLabel')}
          disabled={!top || busy}
          onClick={() => decide('keep')}
        >
          <Check className="size-7" strokeWidth={2.75} />
        </RoundButton>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        {dir === 'rtl' ? t('keyboardHintRtl') : t('keyboardHintLtr')}
      </p>
      {footer}
    </div>
  );
}

function Stamp({
  kind,
  label,
  opacity,
}: {
  kind: 'keep' | 'skip';
  label: string;
  opacity: number;
}) {
  return (
    <span
      aria-hidden
      style={{ opacity }}
      className={cn(
        'pointer-events-none absolute top-8 rounded-lg border-4 px-3 py-1 font-sans text-3xl font-black tracking-[0.12em] uppercase backdrop-blur-[1px] transition-opacity duration-75',
        kind === 'keep'
          ? 'start-6 -rotate-12 border-success bg-success/10 text-success'
          : 'end-6 rotate-12 border-destructive bg-destructive/10 text-destructive',
      )}
    >
      {label}
    </span>
  );
}

function RoundButton({
  tone,
  label,
  disabled,
  onClick,
  children,
  small = false,
}: {
  tone: 'keep' | 'skip' | 'edit';
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  small?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full border-2 shadow-sm transition-transform duration-150 hover:scale-105 active:scale-95 motion-reduce:transform-none',
        small ? 'size-12' : 'size-16',
        tone === 'keep' && 'border-success/50 text-success hover:bg-success/10 hover:text-success',
        tone === 'skip' &&
          'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive',
        tone === 'edit' && 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Button>
  );
}

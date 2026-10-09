'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, ListOrdered, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BlitzCard } from './blitz-model';

// 22.4 — what a Blitz card shows: the rendered carousel (slides swipeable inside the card), the
// rendered slideshow / video (autoplay muted, tap for sound), or for a paid format a preview
// (a still from the business's library with the hook in TikTok-classic text and the script).
// Pointer events that start on the slides scroller stay there, so swiping through slides never
// keeps or skips the card.

const stop = (e: PointerEvent) => e.stopPropagation();

function CarouselSlides({ card }: { card: BlitzCard }) {
  const t = useTranslations('blitz.deck');
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const total = card.slides.length;
  const go = (next: number) => {
    const el = scroller.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(total - 1, next));
    el.scrollTo({
      left: clamped * el.clientWidth * (getComputedStyle(el).direction === 'rtl' ? -1 : 1),
      behavior: 'smooth',
    });
    setIndex(clamped);
  };
  return (
    <div className="relative size-full">
      <div
        ref={scroller}
        onPointerDown={stop}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(Math.abs(el.scrollLeft) / Math.max(1, el.clientWidth)));
        }}
        className="flex size-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [touch-action:pan-x]"
        aria-label={t('slide', { n: index + 1, total })}
      >
        {card.slides.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- signed render URLs, not optimisable
          <img
            key={src}
            src={src}
            alt={i === 0 ? card.hook : (card.body[i - 1] ?? card.title)}
            draggable={false}
            className="size-full shrink-0 snap-center object-cover"
          />
        ))}
      </div>
      {total > 1 && (
        <>
          <button
            type="button"
            onPointerDown={stop}
            onClick={() => go(index - 1)}
            disabled={index === 0}
            aria-label={t('prevSlide')}
            className="absolute start-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur transition hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-0"
          >
            <ChevronLeft className="size-4 rtl:rotate-180" />
          </button>
          <button
            type="button"
            onPointerDown={stop}
            onClick={() => go(index + 1)}
            disabled={index === total - 1}
            aria-label={t('nextSlide')}
            className="absolute end-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur transition hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-0"
          >
            <ChevronRight className="size-4 rtl:rotate-180" />
          </button>
          <div aria-hidden className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {card.slides.map((src, i) => (
              <span
                key={src}
                className={cn(
                  'h-1.5 rounded-full bg-white/60 shadow transition-all duration-300',
                  i === index ? 'w-5 bg-white' : 'w-1.5',
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function VideoMedia({ card, active }: { card: BlitzCard; active: boolean }) {
  const t = useTranslations('blitz.deck');
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (active) void el.play().catch(() => undefined);
    else el.pause();
  }, [active]);
  return (
    <div className="relative size-full bg-black">
      <video
        ref={video}
        src={card.videoUrl ?? undefined}
        poster={card.posterUrl ?? undefined}
        muted={muted}
        loop
        playsInline
        autoPlay={active}
        className="size-full object-cover"
        aria-label={card.title}
      />
      <button
        type="button"
        onPointerDown={stop}
        onClick={() => setMuted((m) => !m)}
        aria-pressed={!muted}
        aria-label={muted ? t('soundOn') : t('soundOff')}
        className="absolute end-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-scrim px-3 py-1.5 text-xs font-medium text-white backdrop-blur transition hover:bg-scrim-strong focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
      >
        {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
        {muted ? t('soundOn') : t('soundOff')}
      </button>
    </div>
  );
}

/** TikTok-classic text: white, heavy, a black outline, no box. */
const CLASSIC_TEXT =
  'font-sans font-extrabold text-white [paint-order:stroke_fill] [-webkit-text-stroke:2px_black] drop-shadow-[0_2px_0_rgba(0,0,0,0.6)]';

function PreviewMedia({ card }: { card: BlitzCard }) {
  const t = useTranslations('blitz.deck');
  return (
    <div className="relative size-full overflow-hidden bg-gradient-to-br from-chart-2/50 via-primary/40 to-chart-4/50">
      {card.previewImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- signed library URL
        <img
          src={card.previewImageUrl}
          alt={t('stillAlt')}
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-scrim/60 via-scrim/20 to-scrim-strong"
      />
      <p
        className={cn(
          'absolute inset-x-6 top-[18%] text-center text-2xl leading-tight',
          CLASSIC_TEXT,
        )}
      >
        {card.hook}
      </p>
      <div className="absolute inset-x-4 bottom-4 rounded-xl bg-scrim p-3 text-white backdrop-blur-sm">
        <p className="mb-1.5 flex items-center gap-1.5 text-[0.6875rem] font-semibold tracking-[0.14em] uppercase">
          <ListOrdered className="size-3" aria-hidden />
          {t('beats')}
        </p>
        <ol className="list-decimal space-y-1 ps-4 text-sm leading-snug">
          {card.body.map((beat) => (
            <li key={beat}>{beat}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function CardMedia({ card, active }: { card: BlitzCard; active: boolean }) {
  if (card.tier === 'preview') return <PreviewMedia card={card} />;
  if (card.format === 'carousel' && card.slides.length > 0) return <CarouselSlides card={card} />;
  if (card.videoUrl) return <VideoMedia card={card} active={active} />;
  return <PreviewMedia card={card} />;
}

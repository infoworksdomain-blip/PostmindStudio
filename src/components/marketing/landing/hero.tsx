import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { STUDIO_CLIPS, type StudioClip } from '@/lib/marketing/media';
import { cn } from '@/lib/utils';
import { ClipMedia, VideosToggle } from './motion';
import { Container, Eyebrow } from './primitives';

// 25.5 §1 — the hero: what Studio does in one line, the two calls to action, and three real
// Studio renders in phone frames (two AI video clips and a slideshow). The front phone's poster is
// the LCP element (eager, fetchpriority high, explicit size); the clips play muted while in view
// on wide screens only.

/** A phone-shaped frame around a 9:16 clip, with an optional format tag under it. */
export function PhoneFrame({
  children,
  tag,
  className,
}: {
  children: ReactNode;
  tag?: string;
  className?: string;
}) {
  return (
    <figure className={cn('m-0', className)}>
      <div className="rounded-[1.75rem] bg-[oklch(0.16_0.005_255)] p-[3.5%] shadow-modal ring-1 ring-border-strong">
        <div className="aspect-[9/16] overflow-hidden rounded-[1.35rem] bg-surface-active">
          {children}
        </div>
      </div>
      {tag && (
        <figcaption className="mt-3 text-center font-mono text-[0.7rem] tracking-[0.12em] text-muted-foreground uppercase">
          {tag}
        </figcaption>
      )}
    </figure>
  );
}

function HeroReel() {
  const t = useTranslations('marketing.hero');
  const tk = useTranslations('marketing.formats.kinds');
  const side = (clip: StudioClip, alt: string, sizes = '(min-width: 1024px) 12rem, 30vw') => (
    <ClipMedia clip={clip} alt={alt} sizes={sizes} />
  );
  return (
    <div className="relative">
      <div
        role="group"
        aria-label={t('reelLabel')}
        className="relative mx-auto grid w-full max-w-[40rem] grid-cols-[1fr_1.25fr_1fr] items-center"
      >
        <PhoneFrame
          tag={tk('aiVideo')}
          className="relative z-0 translate-x-[12%] -rotate-[4deg] rtl:-translate-x-[12%] rtl:rotate-[4deg]"
        >
          {side(STUDIO_CLIPS.seedanceMarket, t('alts.market'))}
        </PhoneFrame>
        <PhoneFrame tag={tk('aiVideo')} className="relative z-10">
          <ClipMedia
            clip={STUDIO_CLIPS.seedanceBread}
            alt={t('alts.bread')}
            sizes="(min-width: 1024px) 15rem, 38vw"
            priority
          />
        </PhoneFrame>
        <PhoneFrame
          tag={tk('slideshow')}
          className="relative z-0 -translate-x-[12%] rotate-[4deg] rtl:translate-x-[12%] rtl:-rotate-[4deg]"
        >
          {side(STUDIO_CLIPS.coastlineStays, t('alts.coastline'))}
        </PhoneFrame>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
        <span>{t('madeWith')}</span>
        <VideosToggle />
      </div>
    </div>
  );
}

export function Hero() {
  const t = useTranslations('marketing.hero');
  return (
    <section
      aria-labelledby="hero-title"
      className="pt-12 pb-[clamp(4rem,2.5rem+5vw,7rem)] md:pt-20"
    >
      <Container className="grid items-center gap-x-12 gap-y-16 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <Eyebrow rec>{t('eyebrow')}</Eyebrow>
          <h1
            id="hero-title"
            className="mt-6 font-display text-[clamp(2.5rem,1.4rem+3.6vw,4.75rem)] leading-[1] text-balance"
          >
            {t.rich('title', {
              em: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
            })}
          </h1>
          <p className="mt-7 max-w-xl text-lg text-pretty text-muted-foreground md:text-xl">
            {t('lede')}
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link href="/sign-up">
                {t('primaryCta')} <ArrowRight aria-hidden className="rtl:-scale-x-100" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-6 text-base">
              <Link href="/pricing">{t('secondaryCta')}</Link>
            </Button>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {(['noEditing', 'yourBrand', 'cancelAnytime'] as const).map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <Check aria-hidden className="size-4 text-success" /> {t(`assurances.${k}`)}
              </li>
            ))}
          </ul>
        </div>
        <HeroReel />
      </Container>
    </section>
  );
}

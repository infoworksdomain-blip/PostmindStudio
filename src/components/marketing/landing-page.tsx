import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Clapperboard,
  Palette,
  CalendarClock,
  ShieldCheck,
  Languages,
  BadgePoundSterling,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { MARKETING_PHOTOS } from '@/lib/marketing/media';
import { FlowCarousel } from './flow-carousel';
import { SceneFrame } from './scene-frame';

// Phase 18 §3 — the public landing page at `/`. Direction: the Studio's own "editorial production
// studio" (paper, ink, one vermilion record light) pushed into a call sheet: a slate strip, a
// timeline for the three steps, a contact sheet of sample renders. Phase 20.8 adds the product
// flow slides (real demo screens) and licensed photos in the hero phone and the contact sheet. Every string is in the
// `marketing` namespace; platform and product names are not translated. Pricing is Track C's
// page, so this only links to /pricing (no amounts here: prices live in Stripe).

const PLATFORMS = ['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook', 'LinkedIn', 'X'];

function Rec({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.2em] uppercase">
      <span aria-hidden className="size-2 animate-rec rounded-full bg-primary" />
      {label}
    </span>
  );
}

function Hero() {
  const t = useTranslations('marketing.hero');
  return (
    <section aria-labelledby="hero-title" className="relative pt-10 pb-20 md:pt-16 md:pb-28">
      <div className="grid items-center gap-14 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <Rec label={t('eyebrow')} />
          <h1
            id="hero-title"
            className="mt-6 font-display text-[clamp(2.9rem,1.6rem+5.2vw,6.2rem)] leading-[0.92]"
          >
            {t.rich('title', {
              em: (chunks) => <em className="text-primary">{chunks}</em>,
            })}
          </h1>
          <p className="mt-7 max-w-xl text-lg text-muted-foreground md:text-xl">{t('lede')}</p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link href="/sign-up">
                {t('primaryCta')} <ArrowRight className="rtl:-scale-x-100" />
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

        <HeroVisual />
      </div>
    </section>
  );
}

/** Phase 20.8: a vertical video in a phone (a licensed photo with the caption and playback bar a
 *  Studio render carries) between two other cuts of the same brief, over the clapperboard slate. */
function HeroVisual() {
  const t = useTranslations('marketing.hero');
  return (
    <div className="relative mx-auto aspect-[100/96] w-full max-w-[34rem]">
      <div aria-hidden className="absolute start-0 top-[14%] w-[33%] -rotate-6">
        <div className="animate-drift [animation-delay:-3s]">
          <SceneFrame
            scene="market"
            ratio="4/5"
            photo={MARKETING_PHOTOS.marketStall}
            caption={t('frames.two')}
            label="Reels · 4:5"
            compact
          />
        </div>
      </div>
      <div aria-hidden className="absolute end-0 top-[26%] w-[33%] rotate-6">
        <div className="animate-drift [animation-delay:-6s]">
          <SceneFrame
            scene="studio"
            ratio="1/1"
            photo={MARKETING_PHOTOS.sourdoughBoard}
            caption={t('frames.three')}
            label="Feed · 1:1"
            compact
          />
        </div>
      </div>
      <div className="absolute start-[29%] top-0 z-10 w-[42%]">
        <div className="animate-drift">
          <div className="rounded-[2rem] bg-foreground p-[5%] shadow-[0_40px_80px_-30px_rgb(20_24_31/0.55)] ring-1 ring-border-strong">
            <SceneFrame
              scene="counter"
              photo={MARKETING_PHOTOS.sourdoughLoaf}
              alt={t('phoneAlt')}
              priority
              caption={t('frames.one')}
              label="TikTok · 0:24"
              compact
              className="rounded-[1.4rem] shadow-none ring-0"
            >
              <span
                aria-hidden
                className="absolute end-3 top-3 inline-flex items-center max-sm:hidden gap-1 rounded-full bg-scrim/80 px-2 py-0.5 text-[0.6rem] font-semibold tracking-widest text-white uppercase backdrop-blur"
              >
                <span className="size-1.5 animate-rec rounded-full bg-primary" />
                Rec
              </span>
              <span
                aria-hidden
                className="absolute inset-x-[7%] bottom-[5%] h-1 overflow-hidden rounded-full bg-white/30"
              >
                <span className="block h-full origin-left animate-playback bg-white rtl:origin-right" />
              </span>
            </SceneFrame>
          </div>
        </div>
      </div>
      {/* The slate: scene, take and timecode, as on a clapperboard. */}
      <div
        aria-hidden
        className="absolute inset-x-[6%] bottom-0 z-20 flex items-center justify-between gap-3 rounded-lg bg-foreground px-4 py-3 font-mono text-[0.7rem] tracking-widest text-background uppercase shadow-xl"
      >
        <span>{t('slate.scene')}</span>
        <span className="text-[oklch(0.75_0.16_38)] dark:text-[oklch(0.5_0.19_35)]">
          ● {t('slate.take')}
        </span>
        <span dir="ltr">00:00:30:00</span>
      </div>
    </div>
  );
}

function Platforms() {
  const t = useTranslations('marketing.platforms');
  return (
    <section aria-labelledby="platforms-title" className="border-y border-border py-8">
      <h2
        id="platforms-title"
        className="mb-4 text-center text-xs tracking-[0.2em] text-muted-foreground uppercase"
      >
        {t('title')}
      </h2>
      <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {PLATFORMS.map((p) => (
          <li key={p} className="font-display text-2xl text-foreground/80 italic md:text-3xl">
            {p}
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEPS = [
  { key: 'brief', time: '00:00' },
  { key: 'review', time: '00:10' },
  { key: 'publish', time: '00:20' },
] as const;

function Steps() {
  const t = useTranslations('marketing.steps');
  return (
    <section aria-labelledby="steps-title" className="py-24">
      <div className="max-w-2xl">
        <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">{t('eyebrow')}</p>
        <h2 id="steps-title" className="mt-3 font-display text-5xl leading-none md:text-6xl">
          {t('title')}
        </h2>
      </div>
      {/* An edit timeline: one track, three clips, a playhead at the start. */}
      <ol className="relative mt-14 grid gap-10 md:grid-cols-3 md:gap-0">
        <span
          aria-hidden
          className="absolute inset-x-0 top-[1.15rem] hidden h-px bg-border md:block"
        />
        {STEPS.map((step, i) => (
          <li key={step.key} className="relative md:pe-10">
            <div className="flex items-center gap-3">
              <span className="relative z-10 grid size-9 place-items-center rounded-full border border-foreground bg-background font-mono text-xs">
                {i + 1}
              </span>
              <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                {step.time}
              </span>
            </div>
            <h3 className="mt-5 font-display text-3xl">{t(`${step.key}.title`)}</h3>
            <p className="mt-2 text-muted-foreground">{t(`${step.key}.body`)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ContactSheet() {
  const t = useTranslations('marketing.samples');
  return (
    <section aria-labelledby="samples-title" className="py-20">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-xl">
          <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">{t('eyebrow')}</p>
          <h2 id="samples-title" className="mt-3 font-display text-5xl leading-none md:text-6xl">
            {t('title')}
          </h2>
          <p className="mt-4 text-muted-foreground">{t('body')}</p>
        </div>
        <p className="max-w-xs text-xs text-muted-foreground">{t('note')}</p>
      </div>
      <div className="mt-12 grid grid-cols-2 gap-4 md:grid-cols-6 md:gap-5">
        <SceneFrame
          scene="market"
          photo={MARKETING_PHOTOS.marketStall}
          alt={t('alts.market')}
          caption={t('captions.market')}
          label="9:16 · 0:24"
          className="md:col-span-2 md:row-span-2"
        />
        <SceneFrame
          scene="studio"
          ratio="16/9"
          photo={MARKETING_PHOTOS.doughKneading}
          alt={t('alts.studio')}
          caption={t('captions.studio')}
          label="16:9 · 2:40"
          className="col-span-2 md:col-span-4"
        />
        <SceneFrame
          scene="workshop"
          ratio="1/1"
          photo={MARKETING_PHOTOS.salonTools}
          alt={t('alts.salon')}
          caption={t('captions.salon')}
          label="1:1 · 0:15"
          className="md:col-span-2"
        />
        <SceneFrame
          scene="dusk"
          ratio="4/5"
          photo={MARKETING_PHOTOS.gym}
          alt={t('alts.gym')}
          caption={t('captions.gym')}
          label="4:5 · 0:30"
          className="md:col-span-2"
        />
      </div>
    </section>
  );
}

const FEATURES = [
  { key: 'brand', icon: Palette },
  { key: 'approvals', icon: ShieldCheck },
  { key: 'calendar', icon: CalendarClock },
  // Operator decision 2026-10-04: no cost caps or spend in customer copy; pricing is per channel.
  { key: 'pricing', icon: BadgePoundSterling },
  { key: 'languages', icon: Languages },
  { key: 'library', icon: Clapperboard },
] as const;

function Features() {
  const t = useTranslations('marketing.features');
  return (
    <section
      aria-labelledby="features-title"
      className="grid gap-12 py-20 lg:grid-cols-[1fr_1.6fr]"
    >
      <div className="lg:sticky lg:top-24 lg:self-start">
        <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">{t('eyebrow')}</p>
        <h2 id="features-title" className="mt-3 font-display text-5xl leading-none md:text-6xl">
          {t('title')}
        </h2>
        <p className="mt-4 max-w-sm text-muted-foreground">{t('body')}</p>
      </div>
      <dl className="grid gap-x-10 sm:grid-cols-2">
        {FEATURES.map(({ key, icon: Icon }) => (
          <div key={key} className="border-t border-foreground/80 py-6">
            <dt className="flex items-center gap-2 font-medium">
              <Icon aria-hidden className="size-4 text-primary" strokeWidth={1.75} />
              {t(`${key}.title`)}
            </dt>
            <dd className="mt-2 text-sm text-muted-foreground">{t(`${key}.body`)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Closing() {
  const t = useTranslations('marketing.closing');
  return (
    <section
      aria-labelledby="closing-title"
      className="relative my-16 overflow-hidden rounded-[1.75rem] bg-foreground px-6 py-16 text-background md:px-14 md:py-20"
    >
      <div
        aria-hidden
        className="absolute -end-24 -top-24 size-80 rounded-full bg-primary/30 blur-3xl"
      />
      <div className="relative max-w-2xl">
        <Rec label={t('eyebrow')} />
        <h2 id="closing-title" className="mt-5 font-display text-5xl leading-[0.95] md:text-7xl">
          {t('title')}
        </h2>
        <p className="mt-5 text-background/70 md:text-lg">{t('body')}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg" className="h-12 px-6 text-base">
            <Link href="/sign-up">
              {t('primaryCta')} <ArrowRight className="rtl:-scale-x-100" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="h-12 border-background/30 bg-transparent px-6 text-base text-background hover:bg-background/10 hover:text-background"
          >
            <Link href="/pricing">{t('secondaryCta')}</Link>
          </Button>
        </div>
        <p className="mt-5 text-xs text-background/60">{t('fineprint')}</p>
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <>
      <Hero />
      <Platforms />
      <Steps />
      <FlowCarousel />
      <ContactSheet />
      <Features />
      <Closing />
    </>
  );
}

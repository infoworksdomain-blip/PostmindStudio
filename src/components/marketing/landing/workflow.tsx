import { useTranslations } from 'next-intl';
import { STUDIO_CLIPS, imgProps, type StudioClipName } from '@/lib/marketing/media';
import { cn } from '@/lib/utils';
import { Band, Container, Eyebrow, Lede, ProductShot, SectionTitle } from './primitives';

// 25.5 §4–§6 — plan and schedule (the real calendar screen, theme-matched), publish everywhere
// (platform names as type, auto-publish and TikTok drafts), and the month planner, Blitz and
// automations ("one prompt, a month of posts").

/** Platform names are not translated and shown as text only (no logos we do not own). */
export const PLATFORMS = [
  'TikTok',
  'Instagram',
  'YouTube Shorts',
  'Facebook',
  'LinkedIn',
  'X',
] as const;

export function PlanSchedule() {
  const t = useTranslations('marketing.plan');
  return (
    <Band labelledBy="plan-title">
      <Container>
        <div data-reveal className="grid gap-x-16 gap-y-6 lg:grid-cols-[1fr_1fr] lg:items-end">
          <div>
            <Eyebrow>{t('eyebrow')}</Eyebrow>
            <SectionTitle id="plan-title">{t('title')}</SectionTitle>
          </div>
          <Lede className="lg:mb-1">{t('body')}</Lede>
        </div>
        <div data-reveal className="mt-14">
          <ProductShot screen="calendar" alt={t('alt')} />
        </div>
      </Container>
    </Band>
  );
}

export function PublishEverywhere() {
  const t = useTranslations('marketing.publish');
  return (
    <Band labelledBy="publish-title" className="border-t border-border">
      <Container>
        <div data-reveal className="max-w-3xl">
          <Eyebrow>{t('eyebrow')}</Eyebrow>
          <SectionTitle id="publish-title">{t('title')}</SectionTitle>
          <Lede>{t('body')}</Lede>
        </div>
        <ul
          data-reveal
          aria-label={t('platformsLabel')}
          className="mt-12 flex flex-wrap gap-x-[clamp(1.25rem,0.5rem+2.5vw,3rem)] gap-y-2"
        >
          {PLATFORMS.map((p) => (
            <li
              key={p}
              lang="en"
              className="font-display text-[clamp(1.75rem,1rem+2.6vw,3.5rem)] leading-tight text-foreground/85"
            >
              {p}
            </li>
          ))}
        </ul>
        <dl
          data-reveal
          className="mt-14 grid gap-x-16 gap-y-8 border-t border-border pt-8 md:grid-cols-2"
        >
          {(['auto', 'drafts'] as const).map((k) => (
            <div key={k}>
              <dt className="font-semibold">{t(`points.${k}.title`)}</dt>
              <dd className="mt-1.5 text-muted-foreground">{t(`points.${k}.body`)}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </Band>
  );
}

/** Where the month grid shows a post (day index → clip); the other days stay empty. */
const MONTH_POSTS: ReadonlyArray<[number, StudioClipName]> = [
  [1, 'northsideBakery'],
  [3, 'pulseStudioText'],
  [6, 'greenleafFlorist'],
  [8, 'harbourCoffee'],
  [10, 'atelierWren'],
  [13, 'coastlineStays'],
  [15, 'seedanceBread'],
  [17, 'pulseStudio'],
  [20, 'coastlineStaysText'],
  [22, 'seedanceMarket'],
  [24, 'northsideBakery'],
  [27, 'harbourCoffee'],
];
const DAYS = 28;

/** A decorative month: four weeks of days, a third of them holding a real Studio post. */
function MonthGrid() {
  const posts = new Map(MONTH_POSTS);
  return (
    <div
      aria-hidden
      className="grid grid-cols-7 gap-1.5 rounded-panel bg-surface-raised p-3 ring-1 ring-border sm:gap-2 sm:p-4"
    >
      {Array.from({ length: DAYS }, (_, day) => {
        const clip = posts.get(day);
        return (
          <div
            key={day}
            className={cn(
              'relative aspect-[9/14] overflow-hidden rounded-[0.4rem]',
              clip ? 'bg-surface-active' : 'bg-background ring-1 ring-border',
            )}
          >
            <span
              className={cn(
                'absolute start-1 top-0.5 z-10 font-mono text-[0.6rem]',
                clip
                  ? 'text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.7)]'
                  : 'text-muted-foreground',
              )}
            >
              {day + 1}
            </span>
            {clip && (
              // eslint-disable-next-line @next/next/no-img-element -- static files with declared sizes; the demo inlines them
              <img
                {...imgProps(STUDIO_CLIPS[clip].poster.small)}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Autopilot() {
  const t = useTranslations('marketing.autopilot');
  return (
    <Band labelledBy="autopilot-title" className="border-t border-border">
      <Container className="grid items-center gap-x-16 gap-y-14 lg:grid-cols-[1fr_1fr]">
        <div>
          <div data-reveal>
            <Eyebrow>{t('eyebrow')}</Eyebrow>
            <SectionTitle id="autopilot-title">{t('title')}</SectionTitle>
            <Lede>{t('body')}</Lede>
          </div>
          <dl className="mt-10 grid">
            {(['planner', 'blitz', 'automations'] as const).map((k) => (
              <div key={k} data-reveal className="border-t border-border py-5">
                <dt className="font-semibold">{t(`items.${k}.title`)}</dt>
                <dd className="mt-1.5 text-muted-foreground">{t(`items.${k}.body`)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div data-reveal className="lg:order-first">
          <MonthGrid />
          <p className="mt-3 text-sm text-muted-foreground">{t('gridCaption')}</p>
        </div>
      </Container>
    </Band>
  );
}

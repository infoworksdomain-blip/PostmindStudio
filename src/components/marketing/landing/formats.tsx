import { useTranslations } from 'next-intl';
import { STUDIO_CLIPS, type StudioClipName } from '@/lib/marketing/media';
import { cn } from '@/lib/utils';
import { ClipMedia } from './motion';
import { Band, Container, Eyebrow, Lede, SectionTitle } from './primitives';

// 25.5 §2 — "One brief, every format": a horizontally scrollable strip of real Studio posts for
// six example businesses, each labelled with the business type and the format. Posters only until
// a visitor on a wide screen points at one; then its muted loop plays.

type Kind = 'aiVideo' | 'slideshow' | 'wallOfText';
type Business = 'bakery' | 'boutique' | 'gym' | 'cottages' | 'florist' | 'coffee';

/** Business names are fictional proper nouns (not translated). */
const NAMES: Record<Business, string> = {
  bakery: 'Northside Bakery',
  boutique: 'Atelier Wren',
  gym: 'Pulse Studio',
  cottages: 'Coastline Stays',
  florist: 'Greenleaf Florist',
  coffee: 'Harbour Coffee',
};

/** The strip shows every clip except the market AI video (it has the video section to itself). */
type ShowcaseClip = Exclude<StudioClipName, 'seedanceMarket'>;

export const SHOWCASE: ReadonlyArray<{ clip: ShowcaseClip; business: Business; kind: Kind }> = [
  { clip: 'seedanceBread', business: 'bakery', kind: 'aiVideo' },
  { clip: 'pulseStudioText', business: 'gym', kind: 'wallOfText' },
  { clip: 'atelierWren', business: 'boutique', kind: 'slideshow' },
  { clip: 'greenleafFlorist', business: 'florist', kind: 'slideshow' },
  { clip: 'coastlineStaysText', business: 'cottages', kind: 'wallOfText' },
  { clip: 'harbourCoffee', business: 'coffee', kind: 'slideshow' },
  { clip: 'northsideBakery', business: 'bakery', kind: 'slideshow' },
  { clip: 'pulseStudio', business: 'gym', kind: 'slideshow' },
  { clip: 'coastlineStays', business: 'cottages', kind: 'slideshow' },
];

export function Formats() {
  const t = useTranslations('marketing.formats');
  return (
    <Band labelledBy="formats-title" className="overflow-hidden">
      <Container>
        <div data-reveal className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
          <div className="max-w-2xl">
            <Eyebrow>{t('eyebrow')}</Eyebrow>
            <SectionTitle id="formats-title">{t('title')}</SectionTitle>
            <Lede>{t('body')}</Lede>
          </div>
          <p className="max-w-xs text-sm text-muted-foreground">{t('note')}</p>
        </div>
      </Container>
      {/* A focusable scroll region (keyboard users scroll it with the arrow keys). */}
      <div
        role="region"
        aria-label={t('stripLabel')}
        tabIndex={0}
        className="relative mt-14 snap-x snap-mandatory scroll-px-4 overflow-x-auto md:scroll-px-[max(2rem,calc((100vw_-_80rem)/2_+_2rem))] overscroll-x-contain pb-6 [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <ul className="mx-auto flex w-max gap-5 px-4 md:gap-7 md:px-[max(2rem,calc((100vw_-_80rem)/2_+_2rem))]">
          {SHOWCASE.map(({ clip, business, kind }, i) => (
            <li
              key={clip}
              className={cn(
                'w-[min(62vw,15rem)] shrink-0 snap-start md:w-[16rem]',
                // Editorial rhythm: every other post sits lower on wide screens.
                i % 2 === 1 && 'md:mt-12',
              )}
            >
              <figure className="m-0">
                <div className="aspect-[9/16] overflow-hidden rounded-panel bg-surface-active ring-1 ring-border">
                  <ClipMedia
                    clip={STUDIO_CLIPS[clip]}
                    alt={t(`alts.${clip}`)}
                    sizes="(min-width: 768px) 16rem, 62vw"
                    play="hover"
                  />
                </div>
                <figcaption className="mt-4 grid gap-0.5">
                  <span className="font-medium">{NAMES[business]}</span>
                  <span className="text-sm text-muted-foreground">
                    {/* One line, one text run: "Sourdough bakery · AI video". */}
                    {t(`types.${business}`)} ·{' '}
                    <span className="text-foreground">{t(`kinds.${kind}`)}</span>
                  </span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}

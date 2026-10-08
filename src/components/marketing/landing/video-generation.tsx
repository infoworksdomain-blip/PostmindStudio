import { useTranslations } from 'next-intl';
import { STUDIO_CLIPS } from '@/lib/marketing/media';
import { ClipMedia, VideosToggle } from './motion';
import { Band, Container, Eyebrow, Lede, ProductShot, SectionTitle } from './primitives';

// 25.5 §3 — video generation, given the most room on the page: a darkroom band with one AI video
// clip large, the one-line brief it came from, and the four things Studio does (script, shots,
// voice and music, captions). Providers are not named here.

const STEPS = ['script', 'shots', 'sound', 'captions'] as const;

export function VideoGeneration() {
  const t = useTranslations('marketing.video');
  return (
    <Band labelledBy="video-title" tone="darkroom">
      <Container className="grid items-start gap-x-16 gap-y-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div data-reveal className="relative mx-auto w-full max-w-[26rem] lg:sticky lg:top-24">
          <figure className="m-0">
            <div className="aspect-[9/16] overflow-hidden rounded-[1.5rem] bg-surface-active shadow-modal ring-1 ring-border-strong">
              <ClipMedia
                clip={STUDIO_CLIPS.seedanceMarket}
                alt={t('alt')}
                sizes="(min-width: 1024px) 26rem, 90vw"
              />
            </div>
            <figcaption className="relative z-10 -mt-16 ms-6 me-10 rounded-panel bg-surface-raised/95 p-4 shadow-overlay ring-1 ring-border backdrop-blur md:-me-10">
              <p className="font-mono text-[0.7rem] tracking-[0.12em] text-muted-foreground uppercase">
                {t('briefLabel')}
              </p>
              <blockquote className="mt-1.5 text-[0.95rem] leading-snug">{t('brief')}</blockquote>
            </figcaption>
          </figure>
          <div className="mt-5 flex justify-center">
            <VideosToggle />
          </div>
        </div>

        <div>
          <div data-reveal>
            <Eyebrow rec>{t('eyebrow')}</Eyebrow>
            <SectionTitle id="video-title">{t('title')}</SectionTitle>
            <Lede>{t('body')}</Lede>
          </div>
          <ol className="mt-12 grid border-t border-border">
            {STEPS.map((step, i) => (
              <li
                key={step}
                data-reveal
                className="grid grid-cols-[3rem_1fr] gap-x-4 border-b border-border py-6"
              >
                <span className="font-mono text-sm text-primary" aria-hidden>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-lg font-semibold">{t(`steps.${step}.title`)}</h3>
                  <p className="mt-1.5 text-muted-foreground">{t(`steps.${step}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
          <div data-reveal className="mt-12">
            <ProductShot screen="script" alt={t('scriptAlt')} theme="dark" />
            <p className="mt-3 text-sm text-muted-foreground">{t('scriptCaption')}</p>
          </div>
        </div>
      </Container>
    </Band>
  );
}

'use client';

import { useTranslations } from 'next-intl';
import { ACTIVE_STATES } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { CarouselEditor } from '../carousel/carousel-editor';
import { CarouselPublishPanel } from '../carousel/carousel-publish-panel';
import { OverlayEditor } from '../overlays/overlay-editor';
import { Section } from '../primitives';
import { SlideshowBuilder } from '../slideshow/slideshow-builder';
import { PublicationsList } from './publications-list';
import { PublishPanel } from './publish-panel';
import { ScriptView } from './script-view';
import { ShotsTab } from './shots-tab';
import { PUBLISHABLE } from './types';
import { VariantCard } from './variant-card';

// The review screen's tabs (spec 14.2), unchanged in what they hold: variants, slides or the
// carousel editor, shots, overlays, script, publish.

export const TAB_KEYS = [
  'slides',
  'carousel',
  'variants',
  'shots',
  'overlays',
  'script',
  'publish',
] as const;
export type TabKey = (typeof TAB_KEYS)[number];
/** 21.6: a carousel has its editor (with preview and downloads) and Publish. */
const CAROUSEL_TABS: readonly TabKey[] = ['carousel', 'publish'];

export function tabKeysFor(project: Pick<ProjectDetail, 'sourceType'>): readonly TabKey[] {
  if (project.sourceType === 'CAROUSEL') return CAROUSEL_TABS;
  return TAB_KEYS.filter(
    (key) => key !== 'carousel' && (key !== 'slides' || project.sourceType === 'SLIDESHOW'),
  );
}

/** 13.1 / 13.2: renders made before the latest script or shot edits. */
export function staleRenderIds(project: ProjectDetail): Set<string> {
  const list = project.metadata?.staleRenders;
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
}

export function ReviewTabContent({
  tab,
  project,
  businessId,
  selectedId,
  onShow,
  onChanged,
}: {
  tab: string;
  project: ProjectDetail;
  businessId: string | null;
  selectedId: string | null;
  /** Show a variant in the player. */
  onShow: (renderId: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations('review.screen');
  const isCarousel = project.sourceType === 'CAROUSEL';
  switch (tab) {
    case 'slides':
      return <SlideshowBuilder project={project} businessId={businessId} onChanged={onChanged} />;
    case 'carousel':
      return (
        <CarouselEditor
          projectId={project.id}
          projectState={project.state}
          businessId={businessId}
          onChanged={onChanged}
        />
      );
    case 'variants': {
      if (project.renders.length === 0)
        return (
          <p className="text-sm text-muted-foreground">
            {ACTIVE_STATES.has(project.state) ? t('variantsWorking') : t('variantsNone')}
          </p>
        );
      const stale = staleRenderIds(project);
      return (
        <div className="grid gap-4 md:grid-cols-2">
          {project.renders.map((r) => (
            <VariantCard
              key={r.id}
              render={r}
              stale={stale.has(r.id)}
              projectState={project.state}
              showing={r.id === selectedId}
              onShow={() => onShow(r.id)}
              onChanged={onChanged}
            />
          ))}
        </div>
      );
    }
    case 'shots':
      return <ShotsTab project={project} onChanged={onChanged} businessId={businessId} />;
    case 'overlays':
      return <OverlayEditor project={project} businessId={businessId} onChanged={onChanged} />;
    case 'script':
      return <ScriptView project={project} onChanged={onChanged} />;
    case 'publish':
      return (
        <div className="grid gap-10 xl:grid-cols-[3fr_2fr]">
          <Section title={t('publishTitle')} description={t('publishDescription')}>
            {!PUBLISHABLE.has(project.state) ? (
              <p className="text-sm text-muted-foreground">{t('approveFirst')}</p>
            ) : isCarousel ? (
              <CarouselPublishPanel
                project={project}
                businessId={businessId}
                onChanged={onChanged}
              />
            ) : (
              <PublishPanel project={project} businessId={businessId} onChanged={onChanged} />
            )}
          </Section>
          <Section title={t('postsTitle')}>
            <PublicationsList publications={project.publications} onChanged={onChanged} />
          </Section>
        </div>
      );
    default:
      return null;
  }
}

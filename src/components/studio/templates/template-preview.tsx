'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFormat } from '@/lib/client/format';
import { BlueprintTimeline } from '../library/blueprint-timeline';
import type { Blueprint, BlueprintShot } from '../library/types';
import { useTemplateCategory } from './category';

// /templates "Preview": what a template contains before it is used: formats, shot structure and
// script outline (project templates), or slide count, pacing and music mood (slideshow templates).

export type TemplateKind = 'project' | 'slideshow';

export interface TemplateRow {
  id: string;
  name: string;
  category: string;
  organisationId: string | null;
  createdAt: string;
  /** Project templates. */
  targetFormats?: Array<{ platform: string; aspectRatio: string; duration: number }>;
  shotBlueprint?: { shots?: unknown } | null;
  scriptTemplate?: string;
  publishDefaults?: { publishPolicy?: string } | null;
  /** Slideshow templates. */
  slidePlan?: unknown;
  musicMood?: string | null;
  defaultDurationPerSlide?: number;
}

const OUTLINE_MAX = 400;

/** The stored shots that look like blueprint shots (a template saved by an older build may not). */
function blueprintShots(row: TemplateRow): BlueprintShot[] {
  const shots = row.shotBlueprint?.shots;
  if (!Array.isArray(shots)) return [];
  return shots.flatMap((raw): BlueprintShot[] => {
    const s = raw as Partial<BlueprintShot> | null;
    if (!s || typeof s.durationSec !== 'number' || typeof s.type !== 'string') return [];
    return [
      {
        durationSec: s.durationSec,
        type: s.type,
        overlayStyle: s.overlayStyle ?? 'none',
        voiceoverPresent: Boolean(s.voiceoverPresent),
        hasOnScreenText: Boolean(s.hasOnScreenText),
      },
    ];
  });
}

function toBlueprint(shots: BlueprintShot[]): Blueprint {
  return {
    shotCount: shots.length,
    totalDurationSec: shots.reduce((sum, s) => sum + s.durationSec, 0),
    shots,
    musicEnvelope: { bpm: null, energy: null, moodTag: null },
    transitionSequence: [],
    hookPattern: '',
    structurePattern: '',
    ctaPattern: null,
    paceTag: '',
  };
}

/** Create with this template applied (parsed by create/body.ts parseInitialTemplate). */
export function templateHref(kind: TemplateKind, id: string): string {
  return `/new?${kind === 'slideshow' ? 'slideshowTemplate' : 'template'}=${encodeURIComponent(id)}`;
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

export function TemplatePreviewDialog({
  row,
  kind,
  onClose,
}: {
  row: TemplateRow;
  kind: TemplateKind;
  onClose: () => void;
}) {
  const t = useTranslations('templates.preview');
  const tl = useTranslations('templates.list');
  const tc = useTranslations('common.actions');
  const f = useFormat();
  const none = useTranslations('format')('none');
  const category = useTemplateCategory();
  const shots = blueprintShots(row);
  const slides = Array.isArray(row.slidePlan) ? row.slidePlan.length : null;
  const outline = row.scriptTemplate?.trim();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <bdi>{row.name}</bdi>
          </DialogTitle>
          <DialogDescription>{category(row.category, true)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {kind === 'project' && row.targetFormats && row.targetFormats.length > 0 && (
            <section className="grid gap-2">
              <Heading>{t('formats')}</Heading>
              <ul aria-label={t('formats')} className="flex flex-wrap gap-2 text-sm">
                {row.targetFormats.map((format) => (
                  <li
                    key={`${format.platform}-${format.aspectRatio}`}
                    className="rounded-full bg-secondary px-3 py-1"
                  >
                    {t('formatLine', {
                      platform: f.platform(format.platform),
                      aspect: format.aspectRatio,
                      seconds: f.number(format.duration),
                    })}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {kind === 'project' && (
            <section className="grid gap-2">
              <Heading>{t('shots')}</Heading>
              {shots.length > 0 ? (
                <BlueprintTimeline blueprint={toBlueprint(shots)} />
              ) : (
                <p className="text-sm text-muted-foreground">{t('noStructure')}</p>
              )}
            </section>
          )}
          {kind === 'project' && outline && (
            <section className="grid gap-2">
              <Heading>{t('outline')}</Heading>
              <p className="text-sm whitespace-pre-line text-muted-foreground">
                {outline.length > OUTLINE_MAX ? `${outline.slice(0, OUTLINE_MAX)}…` : outline}
              </p>
            </section>
          )}
          {kind === 'project' && row.publishDefaults?.publishPolicy === 'AUTO_ON_APPROVAL' && (
            <p className="text-sm text-muted-foreground">{t('autoPublishes')}</p>
          )}
          {kind === 'slideshow' && (
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-muted-foreground">{t('slides')}</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {slides === null ? none : t('slideCount', { count: slides })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('pacing')}</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {row.defaultDurationPerSlide === undefined
                    ? none
                    : t('perSlide', { seconds: f.number(row.defaultDurationPerSlide) })}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">{t('music')}</dt>
                <dd className="mt-0.5 text-sm font-medium">{row.musicMood ?? none}</dd>
              </div>
            </dl>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button asChild>
            <Link href={templateHref(kind, row.id)} aria-label={tl('useAria', { name: row.name })}>
              {tl('use')} <ArrowRight className="rtl:-scale-x-100" />
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

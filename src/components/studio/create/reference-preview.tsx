'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, useApi } from '@/lib/client/api';
import { useAnalysisLabels } from '../library/analysis-labels';
import { BlueprintTimeline } from '../library/blueprint-timeline';
import type { BlueprintResponse } from '../library/types';
import { ErrorState } from '../primitives';
import type { ReferenceMode } from './body';

// What starting from a library reference will do (Addendum A3.6 / A3.7), shown under the banner so
// the choice is informed: TEMPLATE follows the analysed shot structure (the blueprint strip), while
// INSPIRE only borrows the style signature (pace, mood, structure, music feel).

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{value}</dd>
    </div>
  );
}

export function ReferencePreview({ id, mode }: { id: string; mode: ReferenceMode }) {
  const t = useTranslations('create.reference.preview');
  const tf = useTranslations('library.detail.facts');
  const none = useTranslations('format')('none');
  const labels = useAnalysisLabels();
  const { data, error, isLoading } = useApi<BlueprintResponse>(`/library/blueprint/${id}`);

  let body;
  if (isLoading) body = <Skeleton aria-label={t('loading')} className="h-24 rounded-lg" />;
  else if (error instanceof ApiError && error.status === 404)
    body = <p className="text-sm text-muted-foreground">{t('notAnalysed')}</p>;
  else if (error) body = <ErrorState error={error} />;
  else if (data) {
    const s = data.styleSignature;
    body =
      mode === 'TEMPLATE' && data.blueprint ? (
        <BlueprintTimeline blueprint={data.blueprint} />
      ) : (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label={tf('pace')} value={labels.pace(s.paceTag)} />
          <Fact label={tf('mood')} value={s.moodTag} />
          <Fact label={tf('structure')} value={s.structurePattern} />
          <Fact label={tf('music')} value={s.musicGenreTag ?? none} />
        </dl>
      );
  }

  return (
    <section aria-labelledby="reference-preview" className="min-w-0 rounded-xl border p-4">
      <h2 id="reference-preview" className="mb-1 text-sm font-medium">
        {mode === 'TEMPLATE' ? t('templateHeading') : t('inspireHeading')}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {mode === 'TEMPLATE' ? t('templateBody') : t('inspireBody')}
      </p>
      {body}
    </section>
  );
}

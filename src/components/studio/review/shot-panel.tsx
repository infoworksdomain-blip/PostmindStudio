'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Loader2, RotateCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useDescribeFailure } from '../failure-reason';
import { ErrorState } from '../primitives';
import { ShotSwapDelete } from './shot-swap-delete';
import { useShotLabels } from './shot-strip';
import { SHOT_EDITABLE, type ShotDetail } from './types';
import { useAction } from './use-action';

// One shot: its scene, narration and caption; regenerate just this shot with an optional prompt
// override (POST /shots/:id/regenerate) or edit narration / caption, which re-voices only
// (PATCH /shots/:id). 13.2: swap its visual from the library or delete it (shot-swap-delete.tsx).

/** 17.9: the shot's failure reason in the reader's language (provider text untranslated). */
function ShotFailure({ reason }: { reason: string }) {
  const t = useTranslations('review.shot');
  const failure = useDescribeFailure()(reason);
  if (!failure) return null;
  return (
    <p className="mt-2 text-xs text-destructive">
      {t('failed', { reason: failure.text })}
      {failure.detail && (
        <>
          {' '}
          <bdi dir="auto" className="opacity-80">
            {failure.detail}
          </bdi>
        </>
      )}
    </p>
  );
}

export function ShotPanel({
  shotId,
  index,
  projectState,
  onChanged,
  businessId = null,
  isLastShot = false,
  onDeleted = () => undefined,
}: {
  shotId: string;
  index: number;
  projectState: string;
  onChanged: () => void;
  businessId?: string | null;
  isLastShot?: boolean;
  onDeleted?: () => void;
}) {
  const t = useTranslations('review.shot');
  const f = useFormat();
  const labels = useShotLabels();
  const { data, error, isLoading, mutate } = useApi<{ shot: ShotDetail }>(`/shots/${shotId}`);
  const { pending, run, busy } = useAction();
  const [prompt, setPrompt] = useState('');
  const [voiceover, setVoiceover] = useState('');
  const [caption, setCaption] = useState('');
  const shot = data?.shot;
  const editable = SHOT_EDITABLE.has(projectState);

  useEffect(() => {
    setVoiceover(shot?.voiceoverText ?? '');
    setCaption(shot?.onScreenText ?? '');
    setPrompt('');
  }, [shot?.id, shot?.voiceoverText, shot?.onScreenText]);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !shot) return <Skeleton className="h-48 rounded-xl" aria-label={t('loading')} />;

  const textChanged =
    voiceover !== (shot.voiceoverText ?? '') || caption !== (shot.onScreenText ?? '');

  async function regenerate() {
    const ok = await run('regenerate', `/shots/${shotId}/regenerate`, {
      body: prompt.trim() ? { prompt: prompt.trim() } : {},
      success: t('regenerating', { n: index + 1 }),
    });
    if (ok) onChanged();
  }

  async function saveText() {
    const ok = await run('text', `/shots/${shotId}`, {
      method: 'PATCH',
      body: { voiceoverText: voiceover.trim() || null, onScreenText: caption.trim() || null },
      success: t('savedRevoice'),
    });
    if (ok) {
      void mutate();
      onChanged();
    }
  }

  return (
    <div className="grid gap-5 rounded-xl border border-border bg-card p-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
            {t('heading', {
              n: index + 1,
              duration: f.duration(shot.durationSec),
              treatment: labels.treatment(shot.visualTreatment),
            })}
          </p>
          <p className="mt-2 text-sm leading-relaxed">{shot.sceneDescription}</p>
          {shot.cameraDirection && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('camera', { direction: shot.cameraDirection })}
            </p>
          )}
          {shot.errorReason && <ShotFailure reason={shot.errorReason} />}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={`prompt-${shotId}`} className="text-xs font-medium text-muted-foreground">
            {t('promptLabel')}
          </label>
          <Textarea
            id={`prompt-${shotId}`}
            value={prompt}
            maxLength={2000}
            disabled={!editable}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div>
            <Button
              variant="outline"
              onClick={regenerate}
              disabled={!editable || busy || shot.visualTreatment === 'USER_UPLOAD'}
              title={shot.visualTreatment === 'USER_UPLOAD' ? t('uploadedNoRegenerate') : undefined}
            >
              {pending === 'regenerate' ? <Loader2 className="animate-spin" /> : <RotateCw />}
              {t('regenerate')}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-2">
          <label htmlFor={`vo-${shotId}`} className="text-xs font-medium text-muted-foreground">
            {t('narration')}
          </label>
          <Textarea
            id={`vo-${shotId}`}
            value={voiceover}
            maxLength={2000}
            disabled={!editable}
            onChange={(e) => setVoiceover(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={`cap-${shotId}`} className="text-xs font-medium text-muted-foreground">
            {t('onScreen')}
          </label>
          <Textarea
            id={`cap-${shotId}`}
            value={caption}
            maxLength={300}
            disabled={!editable}
            onChange={(e) => setCaption(e.target.value)}
          />
        </div>
        <div>
          <Button onClick={saveText} disabled={!editable || !textChanged || busy}>
            {pending === 'text' ? <Loader2 className="animate-spin" /> : <Save />} {t('saveText')}
          </Button>
        </div>
      </div>
      <ShotSwapDelete
        shotId={shotId}
        index={index}
        businessId={businessId}
        editable={editable}
        isLastShot={isLastShot}
        onChanged={() => {
          void mutate();
          onChanged();
        }}
        onDeleted={onDeleted}
      />
      {!editable && (
        <p className="text-xs text-muted-foreground lg:col-span-2">{t('notEditable')}</p>
      )}
    </div>
  );
}

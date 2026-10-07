'use client';

import { Download, Play, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { useFormat, type Tone } from '@/lib/client/format';
import type { Render } from '@/lib/client/types';
import { useShowCosts } from '../account/use-show-costs';
import { StateBadge } from '../primitives';
import { QualityPanel } from './quality-panel';
import { VariantThumbnail } from './variant-thumbnail';
import type { SignedUrl } from './types';

// One variant (render) per target format (spec 14.2): its details, thumbnail, quality panel and
// download. 25.8: the video itself plays in the screen's one large player ("Watch" picks it).

const QUALITY_TONE: Record<Render['qualityCheckState'], Tone> = {
  PENDING: 'live',
  PASSED: 'good',
  FAILED: 'bad',
  FORCE_APPROVED: 'warn',
};

/** Project states POST /renders/:id/rerender accepts. */
const RERENDERABLE = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'REJECTED']);

export function VariantCard({
  render,
  onChanged,
  stale = false,
  projectState,
  showing = false,
  onShow,
}: {
  render: Render;
  onChanged: () => void;
  /** 13.1 / 13.2: the script or shots changed after this render was made. */
  stale?: boolean;
  projectState?: string;
  /** 25.8: this variant is the one in the player. */
  showing?: boolean;
  /** 25.8: show this variant in the player. */
  onShow?: () => void;
}) {
  const t = useTranslations('review.variant');
  const f = useFormat();
  // Operator decision 2026-10-04: what a render cost is for platform staff only.
  const showCosts = useShowCosts();
  const errorMessage = useErrorMessage();
  const [downloading, setDownloading] = useState(false);
  const [rerendering, setRerendering] = useState(false);

  async function rerender() {
    setRerendering(true);
    try {
      await api(`/renders/${render.id}/rerender`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('rerendering'));
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRerendering(false);
    }
  }
  const quality = {
    label: t(`quality.${render.qualityCheckState}`),
    tone: QUALITY_TONE[render.qualityCheckState],
  };

  async function download() {
    setDownloading(true);
    try {
      const { url } = await api<SignedUrl>(`/renders/${render.id}/download`);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <article
      aria-label={t('aria', { platform: f.platform(render.targetPlatform) })}
      aria-current={showing ? 'true' : undefined}
      className="rounded-xl border border-border bg-card p-4 aria-[current=true]:border-foreground/30"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-display text-2xl leading-none">
              {f.platform(render.targetPlatform)}
            </h3>
            <p className="tabular mt-1 text-xs text-muted-foreground">
              {render.aspectRatio} · {render.resolution} · {f.duration(render.durationSec)}
              {showCosts && <> · {f.pence(render.costPence)}</>}
            </p>
          </div>
          <span className="flex flex-wrap gap-1.5">
            {stale && <StateBadge label={t('outOfDate')} tone="warn" />}
            <StateBadge {...quality} />
          </span>
        </div>
        {stale && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm">
            <span>{t('staleNote')}</span>
            {projectState && RERENDERABLE.has(projectState) && (
              <Button
                loading={rerendering}
                size="sm"
                variant="outline"
                onClick={rerender}
                disabled={rerendering}
              >
                {!rerendering && <RefreshCw />} {t('rerender')}
              </Button>
            )}
          </div>
        )}
        <VariantThumbnail render={render} />
        <QualityPanel render={render} onChanged={onChanged} />
        <div className="flex flex-wrap gap-2">
          {onShow && (
            <Button variant="outline" size="sm" onClick={onShow} aria-pressed={showing}>
              <Play /> {showing ? t('showing') : t('watch')}
            </Button>
          )}
          <Button
            loading={downloading}
            variant="outline"
            size="sm"
            onClick={download}
            disabled={downloading}
          >
            {!downloading && <Download />} {t('download')}
          </Button>
        </div>
      </div>
    </article>
  );
}

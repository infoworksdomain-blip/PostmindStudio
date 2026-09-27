'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { formatDuration, formatPence, PLATFORM_LABEL, type Tone } from '@/lib/client/format';
import type { Render } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { StateBadge } from '../primitives';
import { QualityPanel } from './quality-panel';
import type { SignedUrl } from './types';

// One variant (render) per target format (spec 14.2): inline player from a signed preview URL,
// download, and its quality panel.

const QUALITY: Record<Render['qualityCheckState'], { label: string; tone: Tone }> = {
  PENDING: { label: 'Checking', tone: 'live' },
  PASSED: { label: 'Quality passed', tone: 'good' },
  FAILED: { label: 'Quality failed', tone: 'bad' },
  FORCE_APPROVED: { label: 'Force-approved', tone: 'warn' },
};

const ASPECT_CLASS: Record<string, string> = {
  '9:16': 'aspect-[9/16] max-w-[18rem]',
  '16:9': 'aspect-video',
  '1:1': 'aspect-square max-w-[24rem]',
  '4:5': 'aspect-[4/5] max-w-[22rem]',
};

export function VariantPlayer({ render }: { render: Render }) {
  const { data, error, isLoading } = useApi<SignedUrl>(`/renders/${render.id}/preview`);
  const frame = cn(
    'mx-auto w-full overflow-hidden rounded-lg bg-foreground/90',
    ASPECT_CLASS[render.aspectRatio] ?? 'aspect-video',
  );
  if (isLoading) return <Skeleton className={frame} aria-label="Loading preview" />;
  if (error || !data)
    return (
      <div className={cn(frame, 'grid place-items-center p-4 text-center text-sm text-background')}>
        Preview unavailable — {errorMessage(error)}
      </div>
    );
  return (
    <video
      className={frame}
      src={data.url}
      controls
      playsInline
      preload="metadata"
      aria-label={`${PLATFORM_LABEL[render.targetPlatform] ?? render.targetPlatform} preview`}
    />
  );
}

export function VariantCard({ render, onChanged }: { render: Render; onChanged: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const quality = QUALITY[render.qualityCheckState];

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
      aria-label={`${PLATFORM_LABEL[render.targetPlatform] ?? render.targetPlatform} variant`}
      className="grid gap-5 rounded-xl border border-border bg-card p-4 md:grid-cols-[minmax(0,20rem)_1fr]"
    >
      <VariantPlayer render={render} />
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-display text-2xl leading-none">
              {PLATFORM_LABEL[render.targetPlatform] ?? render.targetPlatform}
            </h3>
            <p className="tabular mt-1 text-xs text-muted-foreground">
              {render.aspectRatio} · {render.resolution} · {formatDuration(render.durationSec)} ·{' '}
              {formatPence(render.costPence)}
            </p>
          </div>
          <StateBadge {...quality} />
        </div>
        <QualityPanel render={render} onChanged={onChanged} />
        <div>
          <Button variant="outline" size="sm" onClick={download} disabled={downloading}>
            {downloading ? <Loader2 className="animate-spin" /> : <Download />} Download MP4
          </Button>
        </div>
      </div>
    </article>
  );
}

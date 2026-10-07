'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { PlatformConnection, ProjectDetail } from '@/lib/client/types';
import { belongsToBusiness } from '../connections/platforms';
import type { PostCopyInfo } from '../hashtags/post-copy-editor';
import { scheduleInputBounds, scheduleProblem } from '../automation/schedule-bounds';
import { carouselNetworks, latestCarouselRender, type CarouselNetwork } from './publish-model';

// 21.6 — publish a carousel: one post per chosen account, with each network's generated caption
// and hashtags (GET /projects/:id/post-copy), now or at a time. Networks that take no carousels
// from Studio are listed with the reason; downloading the slides always works.

interface PostCopyResponse {
  platforms: Record<string, PostCopyInfo>;
}

export function CarouselPublishPanel({
  project,
  businessId,
  onChanged,
}: {
  project: ProjectDetail;
  businessId: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations('carousel.publish');
  const errorMessage = useErrorMessage();
  const connections = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const copy = useApi<PostCopyResponse>(`/projects/${project.id}/post-copy`);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [caption, setCaption] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [openedAt] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const render = latestCarouselRender(project);
  const accounts = (connections.data?.data ?? []).filter(
    (c) => c.state === 'active' && belongsToBusiness(c, businessId),
  );
  const slideCount = render?.slideCount ?? 0;
  const networks = carouselNetworks(accounts, slideCount);
  const selectable = networks.flatMap((n) =>
    n.status === 'ready' ? n.accounts.map((a) => ({ network: n, account: a })) : [],
  );
  const isChosen = (id: string) => chosen[id] ?? true;
  const picked = selectable.filter((s) => isChosen(s.account.id));
  const firstCopy = picked[0] ? copy.data?.platforms[picked[0].network.platform] : undefined;
  const sharedCaption = caption ?? firstCopy?.caption ?? '';
  const scheduleError = scheduleAt ? scheduleProblem(scheduleAt, Date.now()) : null;
  const bounds = scheduleInputBounds(openedAt);

  if (!render) return <p className="text-sm text-muted-foreground">{t('noRender')}</p>;

  async function publish() {
    setSubmitting(true);
    let ok = 0;
    for (const { network, account } of picked) {
      const info = copy.data?.platforms[network.platform];
      try {
        await api('/publications', {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            renderId: render?.id,
            platform: network.platform,
            connectionId: account.id,
            caption: caption ?? info?.caption ?? sharedCaption,
            hashtags: info?.hashtags ?? [],
            ...(scheduleAt && { scheduledFor: new Date(scheduleAt).toISOString() }),
          },
        });
        ok += 1;
      } catch (err) {
        toast.error(
          t('failed', { network: t(`networks.${network.network}`), error: errorMessage(err) }),
        );
      }
    }
    setSubmitting(false);
    if (ok > 0) {
      toast.success(scheduleAt ? t('scheduled', { count: ok }) : t('published', { count: ok }));
      onChanged();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {networks.map((n) => (
          <NetworkRow
            key={n.network}
            network={n}
            isChosen={isChosen}
            onToggle={(id, on) => setChosen((c) => ({ ...c, [id]: on }))}
          />
        ))}
      </ul>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="carousel-caption" className="text-sm">
          {t('caption')}
        </label>
        <textarea
          id="carousel-caption"
          value={sharedCaption}
          rows={4}
          dir="auto"
          onChange={(e) => setCaption(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">{t('captionHint')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="carousel-schedule" className="text-sm">
          {t('schedule')}
        </label>
        <Input
          id="carousel-schedule"
          type="datetime-local"
          value={scheduleAt}
          min={bounds.min}
          max={bounds.max}
          onChange={(e) => setScheduleAt(e.target.value)}
          aria-invalid={scheduleError !== null}
        />
        {scheduleError && (
          <p role="alert" className="text-xs text-destructive">
            {t(`scheduleErrors.${scheduleError}`)}
          </p>
        )}
      </div>
      <div>
        <Button
          loading={submitting}
          type="button"
          disabled={submitting || picked.length === 0 || scheduleError !== null}
          onClick={() => void publish()}
        >
          {!submitting && <Send />}
          {scheduleAt
            ? t('scheduleButton', { count: picked.length })
            : t('publishButton', { count: picked.length })}
        </Button>
      </div>
      {render.aiGenerated && <p className="text-xs text-muted-foreground">{t('aiLabel')}</p>}
    </div>
  );
}

function NetworkRow({
  network,
  isChosen,
  onToggle,
}: {
  network: CarouselNetwork;
  isChosen: (id: string) => boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  const t = useTranslations('carousel.publish');
  const name = t(`networks.${network.network}`);
  return (
    <li className="rounded-lg border border-border px-3 py-2 text-sm">
      <p className="font-medium">{name}</p>
      {network.status === 'ready' ? (
        network.accounts.map((a) => (
          <label key={a.id} className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              checked={isChosen(a.id)}
              onChange={(e) => onToggle(a.id, e.target.checked)}
            />
            <bdi>{a.platformAccountName}</bdi>
          </label>
        ))
      ) : network.status === 'not_connected' ? (
        <p className="text-xs text-muted-foreground">
          {t.rich('notConnected', {
            link: (chunks) => (
              <Link href="/connections" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(`unsupported.${network.status}`, { max: network.maxItems ?? 0 })}
        </p>
      )}
    </li>
  );
}

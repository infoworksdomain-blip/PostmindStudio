'use client';

import Link from 'next/link';
import { ArrowRight, CalendarRange, CircleCheck, ExternalLink, PartyPopper } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail, Publication } from '@/lib/client/types';
import { platformLabel } from '../connections/platforms';
import { EmptyState, ErrorState } from '../primitives';
import { useProjectName } from '@/lib/client/use-project-name';
import { PostingPlanCard } from './posting-plan-card';

// Step 4 — "You just went live on TikTok" (spec 14.5) once the first video has a PUBLISHED
// publication; until then it says the celebration comes when the video goes live.
// 20.3: every state ends with "Plan your month" (one-click posting plans for the drip queue).

const REFRESH_MS = 30_000;

export function firstLive(publications: Publication[]): Publication | undefined {
  return publications
    .filter((p) => p.state === 'PUBLISHED')
    .sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))[0];
}

export function CelebrateStep({
  projectId,
  businessId,
}: {
  projectId: string | null;
  businessId?: string | null;
}) {
  const t = useTranslations('onboarding.celebrate');
  return (
    <div className="flex flex-col gap-6">
      <CelebrateContent projectId={projectId} />
      {businessId && <PostingPlanCard businessId={businessId} />}
      {/* 20.9: or let Studio draft and schedule the whole month. */}
      {businessId && (
        <Link
          href="/plans/new"
          className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2"
        >
          <CalendarRange className="size-4" strokeWidth={1.5} /> {t('planMonth')}
        </Link>
      )}
    </div>
  );
}

function CelebrateContent({ projectId }: { projectId: string | null }) {
  const t = useTranslations('onboarding.celebrate');
  const f = useFormat();
  const projectName = useProjectName();
  const { data, error, mutate } = useApi<{ project: ProjectDetail }>(
    projectId ? `/projects/${projectId}` : null,
    undefined,
    { refreshInterval: REFRESH_MS },
  );
  // Publication platforms have catalogue labels; anything else keeps its connection label.
  const label = (platform: string) => {
    const known = f.platform(platform);
    return known === platform ? platformLabel(platform) : known;
  };

  if (!projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-3xl">{t('noVideo.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('noVideo.body')}</p>
        <div>
          <Button asChild variant="outline">
            <Link href="/new">
              {t('noVideo.action')} <ArrowRight className="rtl:-scale-x-100" />
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return <Skeleton className="h-32 rounded-xl" aria-label={t('loading')} />;

  const live = firstLive(data.project.publications ?? []);
  if (live) {
    const platform = label(live.platform);
    return (
      <div className="flex flex-col gap-4">
        <PartyPopper className="size-10 text-primary" strokeWidth={1.5} />
        <h2 className="font-display text-4xl">{t('live.title', { platform })}</h2>
        <p className="text-sm text-muted-foreground">
          {t('live.body', { name: projectName(data.project.name) })}
        </p>
        <div className="flex flex-wrap gap-2">
          {live.platformUrl && (
            <Button asChild>
              <a href={live.platformUrl} target="_blank" rel="noreferrer noopener">
                {t('live.seeIt', { platform })} <ExternalLink />
              </a>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}`}>{t('live.openProject')}</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <CircleCheck className="size-10 text-primary" strokeWidth={1.5} />
      <h2 className="font-display text-3xl">{t('nearly.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('nearly.body', { name: projectName(data.project.name) })}
      </p>
      <div>
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}`}>
            {t('nearly.action')} <ArrowRight className="rtl:-scale-x-100" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Shown on /welcome once the wizard is finished. */
export function SetupFinished() {
  const t = useTranslations('onboarding.finished');
  return (
    <EmptyState
      media={<PartyPopper className="size-8" strokeWidth={1.5} />}
      title={t('title')}
      description={t('description')}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/new">{t('makeAnother')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/projects">{t('goToProjects')}</Link>
          </Button>
        </div>
      }
    />
  );
}

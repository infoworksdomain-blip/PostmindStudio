'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, CalendarRange, Check, CircleDashed, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { APP_HOME } from '@/lib/auth/page-guard';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail, Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { platformLabel } from '../connections/platforms';
import { EmptyState, ErrorState } from '../primitives';
import { useProjectName } from '@/lib/client/use-project-name';
import { PostingPlanCard } from './posting-plan-card';

// Step 4 (Done) — "You just went live on TikTok" (spec 14.5) once the first video has a PUBLISHED
// publication; until then it says the celebration comes when the video goes live.
// 20.3: every state ends with "Plan your month" (one-click posting plans for the drip queue).
// 25.6: a composed success state (a status mark, no confetti), then what happens next, with Home
// and the month planner one click away.

const REFRESH_MS = 30_000;

export function firstLive(publications: Publication[]): Publication | undefined {
  return publications
    .filter((p) => p.state === 'PUBLISHED')
    .sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))[0];
}

function StatusMark({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-11 place-items-center rounded-full',
        done ? 'bg-success-soft text-success-foreground' : 'bg-surface-raised text-foreground',
      )}
    >
      {done ? (
        <Check className="size-5" strokeWidth={2.25} />
      ) : (
        <CircleDashed className="size-5" strokeWidth={1.75} />
      )}
    </span>
  );
}

function Outcome({
  done,
  title,
  body,
  actions,
}: {
  done: boolean;
  title: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StatusMark done={done} />
      <h2 className="font-display text-[1.75rem] leading-tight text-balance sm:text-[2.25rem]">
        {title}
      </h2>
      <p className="max-w-prose text-[0.9375rem] leading-relaxed text-foreground-secondary">
        {body}
      </p>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** What happens after set-up, in order, with the two places to go next. */
function WhatNext({ businessId }: { businessId?: string | null }) {
  const t = useTranslations('onboarding.celebrate.next');
  const f = useFormat();
  const items = [t('review'), t('publish'), t('insights')];
  return (
    <section
      aria-labelledby="onboarding-next"
      className="rounded-panel bg-surface-raised p-5 sm:p-6"
    >
      <h3 id="onboarding-next" className="text-sm font-medium">
        {t('title')}
      </h3>
      <ol className="mt-3 flex flex-col gap-2.5">
        {items.map((item, i) => (
          <li key={item} className="flex gap-3 text-sm leading-relaxed">
            <span aria-hidden className="w-4 shrink-0 font-mono text-foreground-secondary">
              {f.number(i + 1)}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button asChild variant="outline">
          <Link href={APP_HOME}>
            {t('home')} <ArrowRight aria-hidden className="rtl:-scale-x-100" />
          </Link>
        </Button>
        {/* 20.9: or let Studio draft and schedule the whole month. */}
        {businessId && <PlanMonthLink />}
      </div>
    </section>
  );
}

function PlanMonthLink() {
  const t = useTranslations('onboarding.celebrate');
  return (
    <Link
      href="/plans/new"
      className="inline-flex items-center gap-1.5 rounded-control text-sm text-foreground-secondary underline underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <CalendarRange aria-hidden className="size-4" strokeWidth={1.5} /> {t('planMonth')}
    </Link>
  );
}

export function CelebrateStep({
  projectId,
  businessId,
}: {
  projectId: string | null;
  businessId?: string | null;
}) {
  return (
    <div className="flex flex-col gap-8">
      <CelebrateContent projectId={projectId} />
      <WhatNext businessId={businessId} />
      {businessId && <PostingPlanCard businessId={businessId} />}
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
      <Outcome
        done={false}
        title={t('noVideo.title')}
        body={t('noVideo.body')}
        actions={
          <Button asChild variant="outline">
            <Link href="/new">
              {t('noVideo.action')} <ArrowRight aria-hidden className="rtl:-scale-x-100" />
            </Link>
          </Button>
        }
      />
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return <Skeleton className="h-40 rounded-panel" aria-label={t('loading')} />;

  const live = firstLive(data.project.publications ?? []);
  if (live) {
    const platform = label(live.platform);
    return (
      <Outcome
        done
        title={t('live.title', { platform })}
        body={t('live.body', { name: projectName(data.project.name) })}
        actions={
          <>
            {live.platformUrl && (
              <Button asChild>
                <a href={live.platformUrl} target="_blank" rel="noreferrer noopener">
                  {t('live.seeIt', { platform })} <ExternalLink aria-hidden />
                </a>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href={`/projects/${projectId}`}>{t('live.openProject')}</Link>
            </Button>
          </>
        }
      />
    );
  }
  return (
    <Outcome
      done={false}
      title={t('nearly.title')}
      body={t('nearly.body', { name: projectName(data.project.name) })}
      actions={
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}`}>
            {t('nearly.action')} <ArrowRight aria-hidden className="rtl:-scale-x-100" />
          </Link>
        </Button>
      }
    />
  );
}

/** Shown on /welcome once the wizard is finished. */
export function SetupFinished() {
  const t = useTranslations('onboarding.finished');
  return (
    <EmptyState
      media={<Check className="size-7" strokeWidth={2} />}
      title={t('title')}
      description={t('description')}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href={APP_HOME}>{t('goHome')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/new">{t('makeAnother')}</Link>
          </Button>
        </div>
      }
    />
  );
}

'use client';

import Link from 'next/link';
import { ArrowRight, ExternalLink, PartyPopper, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { PLATFORM_LABEL } from '@/lib/client/format';
import type { ProjectDetail, Publication } from '@/lib/client/types';
import { platformLabel } from '../connections/platforms';
import { EmptyState, ErrorState } from '../primitives';

// Step 4 — "You just went live on TikTok" (spec 14.5) once the first video has a PUBLISHED
// publication; until then it says the celebration comes when the video goes live.

const REFRESH_MS = 30_000;

export function firstLive(publications: Publication[]): Publication | undefined {
  return publications
    .filter((p) => p.state === 'PUBLISHED')
    .sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))[0];
}

function label(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platformLabel(platform);
}

export function CelebrateStep({ projectId }: { projectId: string | null }) {
  const { data, error, mutate } = useApi<{ project: ProjectDetail }>(
    projectId ? `/projects/${projectId}` : null,
    undefined,
    { refreshInterval: REFRESH_MS },
  );

  if (!projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-3xl">Almost there</h2>
        <p className="text-sm text-muted-foreground">
          When your first video goes live, we’ll celebrate it here. Make one whenever you’re ready.
        </p>
        <div>
          <Button asChild variant="outline">
            <Link href="/new">
              Make a video <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return <Skeleton className="h-32 rounded-xl" aria-label="Loading your video" />;

  const live = firstLive(data.project.publications ?? []);
  if (live) {
    return (
      <div className="flex flex-col gap-4">
        <PartyPopper className="size-10 text-primary" strokeWidth={1.5} />
        <h2 className="font-display text-4xl">You just went live on {label(live.platform)}</h2>
        <p className="text-sm text-muted-foreground">
          “{data.project.name}” is out in the world. Studio tracks how it does in Analytics.
        </p>
        <div className="flex flex-wrap gap-2">
          {live.platformUrl && (
            <Button asChild>
              <a href={live.platformUrl} target="_blank" rel="noreferrer noopener">
                See it on {label(live.platform)} <ExternalLink />
              </a>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}`}>Open the project</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Sparkles className="size-10 text-primary" strokeWidth={1.5} />
      <h2 className="font-display text-3xl">Nearly live</h2>
      <p className="text-sm text-muted-foreground">
        “{data.project.name}” isn’t published yet. Review and approve it, then publish — we’ll
        celebrate here the moment it goes live.
      </p>
      <div>
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}`}>
            Open your video <ArrowRight />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Shown on /welcome once the wizard is finished. */
export function SetupFinished() {
  return (
    <EmptyState
      icon={<PartyPopper className="size-8" strokeWidth={1.5} />}
      title="You’re all set"
      description="Studio is ready to make and publish videos for your business."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/new">Make another video</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/projects">Go to projects</Link>
          </Button>
        </div>
      }
    />
  );
}

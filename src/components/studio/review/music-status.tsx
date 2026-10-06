'use client';

import { Music, VolumeX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ProjectDetail } from '@/lib/client/types';

// Review screen: what happened to Layer 5 music for the latest run (pipeline/music.ts writes
// project.metadata.music). Generated / off for this plan / failed (non-fatal: the video was
// rendered with narration only). Older projects have `{ skipped }` from before music existed.

export type MusicState =
  | { status: 'generated'; reused: boolean; durationSec: number | null }
  | { status: 'off_for_plan' }
  | { status: 'failed'; reason: string | null }
  | { status: 'none' };

export function readMusic(metadata: unknown): MusicState | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const music = (metadata as { music?: unknown }).music;
  if (!music || typeof music !== 'object') return null;
  const m = music as Record<string, unknown>;
  // 23.1: a track reused from the music library reads like any other reused track.
  if (m.status === 'generated' || m.status === 'reused')
    return {
      status: 'generated',
      reused: m.status === 'reused' || m.reused === true,
      durationSec: typeof m.durationSec === 'number' ? m.durationSec : null,
    };
  if (m.status === 'off_for_plan') return { status: 'off_for_plan' };
  if (m.status === 'failed')
    return { status: 'failed', reason: typeof m.reason === 'string' ? m.reason : null };
  if (typeof m.skipped === 'string') return { status: 'none' };
  return null;
}

type MusicT = ReturnType<typeof useTranslations<'review.music'>>;

function text(state: MusicState, t: MusicT): string {
  switch (state.status) {
    case 'generated': {
      if (!state.durationSec) return state.reused ? t('generatedReused') : t('generated');
      const seconds = Math.round(state.durationSec);
      return state.reused
        ? t('generatedTrackReused', { seconds })
        : t('generatedTrack', { seconds });
    }
    case 'off_for_plan':
      return t('offForPlan');
    case 'failed':
      return t('failed');
    case 'none':
      return t('none');
  }
}

export function MusicStatus({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.music');
  const state = readMusic(project.metadata);
  if (!state) return null;
  const Icon = state.status === 'generated' ? Music : VolumeX;
  return (
    <p
      aria-label={t('aria')}
      className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm"
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${state.status === 'failed' ? 'text-amber-600' : 'text-muted-foreground'}`}
        strokeWidth={1.5}
      />
      <span>
        {text(state, t)}
        {state.status === 'failed' && state.reason && (
          <span className="block text-xs text-muted-foreground">{state.reason}</span>
        )}
      </span>
    </p>
  );
}

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Clock, Info, PauseCircle, ShieldAlert } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { useAction } from './use-action';

// Review screen notes for runs that are paused rather than broken:
//   - 13.20: the organisation's daily / monthly generation budget paused the run; it resumes
//     automatically after the rollover (00:05 UTC; monthly on the 1st) unless turned off here
//     (PATCH /projects/:id { autoResume }).
//   - 13.17: the run waits for PostMind's content-safety review.

type Pause = { scope?: string; period?: string };

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function orgCapPause(
  project: Pick<ProjectDetail, 'state' | 'errorReason' | 'metadata'>,
): 'org_daily' | 'org_monthly' | null {
  if (project.state !== 'FAILED' || !(project.errorReason ?? '').startsWith('cost_cap_paused'))
    return null;
  const scope = (record(project.metadata?.costPause) as Pause | null)?.scope;
  return scope === 'org_daily' || scope === 'org_monthly' ? scope : null;
}

export function AutoResumeNote({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.paused');
  const ta = useTranslations('review.actions');
  const { run, busy } = useAction();
  const [enabled, setEnabled] = useState(project.metadata?.autoResume !== false);
  const scope = orgCapPause(project);
  if (!scope) return null;

  const toggle = async (next: boolean) => {
    setEnabled(next);
    const ok = await run('auto-resume', `/projects/${project.id}`, {
      method: 'PATCH',
      body: { autoResume: next },
      success: next ? t('willResume') : t('resumeTurnedOff'),
    });
    if (ok) onChanged();
    else setEnabled(!next);
  };

  return (
    <section
      aria-label={t('aria')}
      className="flex flex-col gap-2 rounded-xl border border-foreground/15 bg-card p-4 text-sm"
    >
      <p className="flex items-start gap-2">
        <PauseCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        {scope === 'org_daily' ? t('daily') : t('monthly')}{' '}
        {enabled
          ? scope === 'org_daily'
            ? t('resumesDaily')
            : t('resumesMonthly')
          : t('resumeOff', { action: ta('generateAgain') })}
      </p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={(v) => void toggle(v)}
          aria-label={t('resumeToggle')}
        />
        {t('resumeToggle')}
      </label>
    </section>
  );
}

export function SafetyReviewNote({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.paused');
  const marker = record(project.metadata?.safetyReview);
  if (marker?.state !== 'PENDING') return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
      {t('safety')}
    </p>
  );
}

// 15.B9 — spec 20: "user notified of quality tier drop if fallback used". compose-video records
// metadata.fallbacks[] when a preferred provider was passed over at run time (disabled, over
// budget, too slow, circuit open) and a later one produced the output.

const LAYERS = ['visual', 'voice', 'music', 'composition'] as const;
const REASONS = [
  'provider_disabled',
  'over_budget',
  'too_slow',
  'no_cost_estimate',
  'circuit_open',
] as const;
const oneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

export interface FallbackItem {
  layer: string;
  shotId?: string;
  usedProviderId: string;
  skipped: Array<{ providerId: string; reason: string }>;
}

export function fallbacksOf(metadata: ProjectDetail['metadata']): FallbackItem[] {
  const list = metadata?.fallbacks;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const r = record(v);
    if (!r || typeof r.layer !== 'string' || typeof r.usedProviderId !== 'string') return [];
    const skipped = Array.isArray(r.skipped)
      ? r.skipped.flatMap((s) => {
          const x = record(s);
          return x && typeof x.providerId === 'string' && typeof x.reason === 'string'
            ? [{ providerId: x.providerId, reason: x.reason }]
            : [];
        })
      : [];
    return [
      {
        layer: r.layer,
        usedProviderId: r.usedProviderId,
        skipped,
        ...(typeof r.shotId === 'string' && { shotId: r.shotId }),
      },
    ];
  });
}

export function FallbackNote({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.fallback');
  const f = useFormat();
  const items = fallbacksOf(project.metadata);
  if (items.length === 0) return null;
  const layerLabel = (layer: string) => (oneOf(LAYERS, layer) ? t(`layers.${layer}`) : layer);
  const reasonLabel = (reason: string) =>
    oneOf(REASONS, reason) ? t(`reasons.${reason}`) : reason;
  const layers = [...new Set(items.map((i) => layerLabel(i.layer)))];
  return (
    <section
      aria-label={t('aria')}
      className="flex flex-col gap-1 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <p className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
        {t('intro', { layers: f.list(layers) })}
      </p>
      <ul className="ps-6 text-xs text-muted-foreground">
        {items.map((i, n) => (
          <li key={`${i.layer}-${i.shotId ?? n}`}>
            {t('item', {
              layer: layerLabel(i.layer),
              provider: i.usedProviderId,
              skipped: f.list(
                i.skipped.map((s) =>
                  t('skipped', { provider: s.providerId, reason: reasonLabel(s.reason) }),
                ),
              ),
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

// 20.29 — the run's work is waiting for a busy video provider (many videos at once): the worker
// delayed it rather than failing it and recorded metadata.providerWait { at, retryAt }. While the
// run is in progress and the last wait is recent, say so plainly: "queued, starts soon".

const WAITING_STATES = new Set([
  'QUEUED',
  'PLANNING',
  'ASSETS_QUEUED',
  'ASSETS_GENERATING',
  'RENDERING',
  'QUALITY_CHECKING',
]);
/** A wait whose retry time is older than this is stale (the work has started since). */
export const PROVIDER_WAIT_FRESH_MS = 3 * 60_000;

export function waitingForProvider(
  project: Pick<ProjectDetail, 'state' | 'metadata'>,
  now: number = Date.now(),
): boolean {
  if (!WAITING_STATES.has(project.state)) return false;
  const wait = record(project.metadata?.providerWait);
  const retryAt = typeof wait?.retryAt === 'string' ? Date.parse(wait.retryAt) : Number.NaN;
  return Number.isFinite(retryAt) && now - retryAt < PROVIDER_WAIT_FRESH_MS;
}

export function QueuedNote({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.queued');
  if (!waitingForProvider(project)) return null;
  return (
    <p
      role="status"
      aria-label={t('aria')}
      className="flex items-start gap-2 rounded-xl border border-foreground/15 bg-card px-3 py-2 text-sm"
    >
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      {t('note')}
    </p>
  );
}

// 20.19 — an AI_AVATAR shot whose presenter was unavailable (e.g. the avatar provider's account
// ran out of credits) was made as a regular generated clip instead of failing the video.
// compose-video records metadata.degradedShots[]; the customer sees one gentle sentence (no
// provider names or reasons — those stay in the shot's routing for staff).

function degradedShots(metadata: ProjectDetail['metadata'], from: string): string[] {
  const list = metadata?.degradedShots;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const r = record(v);
    return r && r.degradedFrom === from && typeof r.shotId === 'string' ? [r.shotId] : [];
  });
}

export function degradedPresenterShots(metadata: ProjectDetail['metadata']): string[] {
  return degradedShots(metadata, 'avatar_video');
}

/** 21.4: UGC actor shots made as narrated clips because no actor provider was available. */
export function degradedActorShots(metadata: ProjectDetail['metadata']): string[] {
  return degradedShots(metadata, 'actor_video');
}

export function ActorFallbackNote({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.actorFallback');
  if (degradedActorShots(project.metadata).length === 0) return null;
  return (
    <p
      role="note"
      aria-label={t('aria')}
      className="flex items-start gap-2 rounded-xl border border-foreground/15 bg-card px-3 py-2 text-sm"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      {t('note')}
    </p>
  );
}

export function PresenterFallbackNote({ project }: { project: ProjectDetail }) {
  const t = useTranslations('review.presenterFallback');
  if (degradedPresenterShots(project.metadata).length === 0) return null;
  return (
    <p
      role="note"
      aria-label={t('aria')}
      className="flex items-start gap-2 rounded-xl border border-foreground/15 bg-card px-3 py-2 text-sm"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      {t('note')}
    </p>
  );
}

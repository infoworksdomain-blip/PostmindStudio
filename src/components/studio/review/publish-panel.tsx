'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Loader2, Send, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat, type StudioFormat } from '@/lib/client/format';
import type {
  MetaConnectInfo,
  PlatformConnection,
  ProjectDetail,
  Render,
} from '@/lib/client/types';
import { MAX_SCHEDULE_AHEAD_DAYS } from '@/lib/studio/schedule-window';
import { scheduleInputBounds, scheduleProblem } from '../automation/schedule-bounds';
import { belongsToBusiness, isMetaPlatform } from '../connections/platforms';
import { Field, NativeSelect } from './field';
import { RENDER_CONNECTION, RENDER_PUBLISHABLE } from './types';

// Spec 14.2 publish controls: per-variant enable, account, caption and hashtags; publish all now
// or schedule. One POST /publications per enabled variant.
// 15.A7: "Suggest captions" fills each variant with its per-platform caption and hashtags (spec
// 9.8, POST /projects/:id/caption-suggestions); edited variants are left alone.
// 15.A6: the schedule picker shows an advisory best time (GET /analytics/best-times).

interface BestTimes {
  bestPerDay: Array<{ weekday: number; hour: number; score: number; basis: string }>;
  sufficientData: boolean;
}

interface Suggestion {
  caption: string;
  hashtags: string[];
}

export interface BestTime {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  hour: number;
  sufficientData: boolean;
}

/** The best-scoring day and hour, or null. */
export function bestTime(best: BestTimes | undefined): BestTime | null {
  const top = [...(best?.bestPerDay ?? [])].sort((a, b) => b.score - a.score)[0];
  if (!top) return null;
  return { weekday: top.weekday, hour: top.hour, sufficientData: Boolean(best?.sufficientData) };
}

/** The weekday and hour in the locale's words ("Tue" / "08:00", "mar." / "08:00"). */
export function bestTimeParts(time: BestTime, f: StudioFormat): { day: string; time: string } {
  // 7 January 2024 was a Sunday: add the weekday to reach that day of the week.
  const at = new Date(2024, 0, 7 + time.weekday, time.hour, 0).toISOString();
  return {
    day: f.date(at, { weekday: 'short' }),
    time: f.date(at, { hour: '2-digit', minute: '2-digit' }),
  };
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface VariantDraft {
  enabled: boolean;
  connectionId: string;
  caption: string;
  hashtags: string;
}

export function parseHashtags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#+/, '').trim())
        .filter(Boolean),
    ),
  ];
}

export function connectionsFor(
  render: Render,
  connections: PlatformConnection[],
  businessId: string | null,
): PlatformConnection[] {
  const platform = RENDER_CONNECTION[render.targetPlatform];
  if (!platform) return [];
  return connections.filter(
    (c) => c.platform === platform && c.state === 'active' && belongsToBusiness(c, businessId),
  );
}

export function PublishPanel({
  project,
  businessId,
  onChanged,
}: {
  project: ProjectDetail;
  businessId: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations('review.publish');
  const tc = useTranslations('connections');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const { data, error } = useApi<{ data: PlatformConnection[]; meta?: MetaConnectInfo }>(
    '/platform-connections',
  );
  // Phase 18: "connect in PostMind settings" only when Core runs the Meta login (core mode).
  const coreMeta = data?.meta?.connect === 'core';
  const [drafts, setDrafts] = useState<Record<string, VariantDraft>>({});
  const [scheduleAt, setScheduleAt] = useState('');
  // 20.3: the API's window (a minute to 180 days ahead) as input bounds and a client check.
  const [openedAt] = useState(() => Date.now());
  const bounds = scheduleInputBounds(openedAt);
  const [scheduleError, setScheduleError] = useState<'inPast' | 'tooFar' | null>(null);
  const changeSchedule = (value: string) => {
    setScheduleAt(value);
    setScheduleError(scheduleProblem(value, Date.now()));
  };
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const { data: best } = useApi<BestTimes>('/analytics/best-times', {
    ...(businessId && { businessId }),
    timezone: browserTimeZone(),
  });
  const best0 = bestTime(best);
  const bestLabel = best0
    ? t(best0.sufficientData ? 'suggested' : 'suggestedLittleData', bestTimeParts(best0, f))
    : null;
  const renders = project.renders.filter((r) => RENDER_PUBLISHABLE.has(r.qualityCheckState));
  const connections = data?.data ?? [];

  const draftFor = (render: Render): VariantDraft => {
    const options = connectionsFor(render, connections, businessId);
    return (
      drafts[render.id] ?? {
        enabled: options.length > 0,
        connectionId: options[0]?.id ?? '',
        caption: suggestions[render.targetPlatform]?.caption ?? project.brief?.hook ?? '',
        hashtags: (suggestions[render.targetPlatform]?.hashtags ?? [])
          .map((t) => `#${t}`)
          .join(' '),
      }
    );
  };
  const update = (render: Render, patch: Partial<VariantDraft>) =>
    setDrafts((d) => ({ ...d, [render.id]: { ...draftFor(render), ...patch } }));

  const selected = renders.filter((r) => {
    const d = draftFor(r);
    return d.enabled && d.connectionId;
  });

  async function suggest() {
    setSuggesting(true);
    try {
      const res = await api<{ suggestions: Record<string, Suggestion> }>(
        `/projects/${project.id}/caption-suggestions`,
        { method: 'POST', idempotencyKey: newIdempotencyKey(), body: {} },
      );
      setSuggestions(res.suggestions);
      toast.success(t('captionsSuggested'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  async function publish() {
    const problem = scheduleProblem(scheduleAt, Date.now());
    setScheduleError(problem);
    if (problem) return;
    const scheduledFor = scheduleAt ? new Date(scheduleAt).toISOString() : undefined;
    setSubmitting(true);
    let done = 0;
    for (const render of selected) {
      const d = draftFor(render);
      try {
        await api('/publications', {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            renderId: render.id,
            platform: render.targetPlatform,
            connectionId: d.connectionId,
            caption: d.caption.trim(),
            hashtags: parseHashtags(d.hashtags),
            ...(scheduledFor && { scheduledFor }),
          },
        });
        done += 1;
      } catch (err) {
        toast.error(
          t('platformError', {
            platform: f.platform(render.targetPlatform),
            error: errorMessage(err),
          }),
        );
      }
    }
    setSubmitting(false);
    if (done) {
      toast.success(
        scheduledFor ? t('scheduled', { count: done }) : t('publishing', { count: done }),
      );
      onChanged();
    }
  }

  if (renders.length === 0) return <p className="text-sm text-muted-foreground">{t('noPassed')}</p>;
  // 20.12: no connected account can post any variant — say so once instead of "Publish now (0)".
  const noAccounts =
    data !== undefined &&
    renders.every((r) => connectionsFor(r, connections, businessId).length === 0);

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      {noAccounts && (
        <p
          role="status"
          className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
        >
          {t('noAccounts')}{' '}
          {coreMeta ? null : (
            <Link href="/connections" className="text-foreground underline underline-offset-2">
              {t('connectAccount')}
            </Link>
          )}
        </p>
      )}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={suggest} disabled={suggesting}>
          {suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {t('suggest')}
        </Button>
      </div>
      <ul className="flex flex-col gap-3">
        {renders.map((render) => {
          const label = f.platform(render.targetPlatform);
          const options = connectionsFor(render, connections, businessId);
          const d = draftFor(render);
          const connectionPlatform = RENDER_CONNECTION[render.targetPlatform] ?? '';
          return (
            <li key={render.id} className="rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={d.enabled && options.length > 0}
                  disabled={options.length === 0}
                  onChange={(e) => update(render, { enabled: e.target.checked })}
                />
                {label}
              </label>
              {options.length === 0 && coreMeta && isMetaPlatform(connectionPlatform) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('noAccount')} {tc('meta.guidance')}
                </p>
              )}
              {options.length === 0 &&
                connectionPlatform &&
                !(coreMeta && isMetaPlatform(connectionPlatform)) && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('noAccount')}{' '}
                    <Link href="/connections" className="underline">
                      {t('connect', { platform: label })}
                    </Link>
                  </p>
                )}
              {options.length > 0 && d.enabled && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field id={`acct-${render.id}`} label={t('account')}>
                    <NativeSelect
                      id={`acct-${render.id}`}
                      value={d.connectionId}
                      onChange={(e) => update(render, { connectionId: e.target.value })}
                    >
                      {options.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.platformAccountName}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field id={`tags-${render.id}`} label={t('hashtags')}>
                    <Input
                      id={`tags-${render.id}`}
                      value={d.hashtags}
                      placeholder={t('hashtagsPlaceholder')}
                      onChange={(e) => update(render, { hashtags: e.target.value })}
                    />
                  </Field>
                  <Field id={`caption-${render.id}`} label={t('caption')} className="sm:col-span-2">
                    <Textarea
                      id={`caption-${render.id}`}
                      value={d.caption}
                      onChange={(e) => update(render, { caption: e.target.value })}
                    />
                  </Field>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field id="publish-schedule" label={t('schedule')} className="w-full sm:w-64">
          <Input
            id="publish-schedule"
            type="datetime-local"
            min={bounds.min}
            max={bounds.max}
            value={scheduleAt}
            aria-invalid={scheduleError ? true : undefined}
            aria-describedby={scheduleError ? 'publish-schedule-error' : undefined}
            onChange={(e) => changeSchedule(e.target.value)}
          />
          {scheduleError && (
            <p id="publish-schedule-error" role="alert" className="mt-1 text-xs text-destructive">
              {scheduleError === 'tooFar'
                ? t('scheduleTooFar', { days: MAX_SCHEDULE_AHEAD_DAYS })
                : t('scheduleInPast')}
            </p>
          )}
          {bestLabel && <p className="mt-1 text-xs text-muted-foreground">{bestLabel}</p>}
        </Field>
        <Button
          onClick={publish}
          disabled={submitting || selected.length === 0 || scheduleError !== null}
        >
          {submitting ? (
            <Loader2 className="animate-spin" />
          ) : scheduleAt ? (
            <CalendarClock />
          ) : (
            <Send />
          )}
          {scheduleAt
            ? t('scheduleCount', { count: selected.length })
            : t('publishNowCount', { count: selected.length })}
        </Button>
      </div>
    </div>
  );
}

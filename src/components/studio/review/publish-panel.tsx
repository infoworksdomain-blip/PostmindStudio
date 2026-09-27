'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { PLATFORM_LABEL } from '@/lib/client/format';
import type { PlatformConnection, ProjectDetail, Render } from '@/lib/client/types';
import { belongsToBusiness, isMetaPlatform, META_CONNECT_GUIDANCE } from '../connections/platforms';
import { Field, NativeSelect } from './field';
import { RENDER_CONNECTION, RENDER_PUBLISHABLE } from './types';

// Spec 14.2 publish controls: per-variant enable, account, caption and hashtags; publish all now
// or schedule. One POST /publications per enabled variant.

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
  const { data, error } = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const [drafts, setDrafts] = useState<Record<string, VariantDraft>>({});
  const [scheduleAt, setScheduleAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const renders = project.renders.filter((r) => RENDER_PUBLISHABLE.has(r.qualityCheckState));
  const connections = data?.data ?? [];

  const draftFor = (render: Render): VariantDraft => {
    const options = connectionsFor(render, connections, businessId);
    return (
      drafts[render.id] ?? {
        enabled: options.length > 0,
        connectionId: options[0]?.id ?? '',
        caption: project.brief?.hook ?? '',
        hashtags: '',
      }
    );
  };
  const update = (render: Render, patch: Partial<VariantDraft>) =>
    setDrafts((d) => ({ ...d, [render.id]: { ...draftFor(render), ...patch } }));

  const selected = renders.filter((r) => {
    const d = draftFor(r);
    return d.enabled && d.connectionId;
  });

  async function publish() {
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
          `${PLATFORM_LABEL[render.targetPlatform] ?? render.targetPlatform}: ${errorMessage(err)}`,
        );
      }
    }
    setSubmitting(false);
    if (done) {
      toast.success(
        scheduledFor ? `Scheduled ${done} post${done === 1 ? '' : 's'}.` : `Publishing ${done}.`,
      );
      onChanged();
    }
  }

  if (renders.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No variant has passed its quality check.</p>
    );

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
      <ul className="flex flex-col gap-3">
        {renders.map((render) => {
          const label = PLATFORM_LABEL[render.targetPlatform] ?? render.targetPlatform;
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
              {options.length === 0 && isMetaPlatform(connectionPlatform) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  No connected account. {META_CONNECT_GUIDANCE}
                </p>
              )}
              {options.length === 0 &&
                connectionPlatform &&
                !isMetaPlatform(connectionPlatform) && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No connected account.{' '}
                    <Link href="/connections" className="underline">
                      Connect {label}
                    </Link>
                  </p>
                )}
              {options.length > 0 && d.enabled && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field id={`acct-${render.id}`} label="Account">
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
                  <Field id={`tags-${render.id}`} label="Hashtags">
                    <Input
                      id={`tags-${render.id}`}
                      value={d.hashtags}
                      placeholder="#spring #menu"
                      onChange={(e) => update(render, { hashtags: e.target.value })}
                    />
                  </Field>
                  <Field id={`caption-${render.id}`} label="Caption" className="sm:col-span-2">
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
        <Field id="publish-schedule" label="Schedule (optional)" className="w-full sm:w-64">
          <Input
            id="publish-schedule"
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
          />
        </Field>
        <Button onClick={publish} disabled={submitting || selected.length === 0}>
          {submitting ? (
            <Loader2 className="animate-spin" />
          ) : scheduleAt ? (
            <CalendarClock />
          ) : (
            <Send />
          )}
          {scheduleAt ? 'Schedule' : 'Publish now'} ({selected.length})
        </Button>
      </div>
    </div>
  );
}

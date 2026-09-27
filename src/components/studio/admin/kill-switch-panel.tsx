'use client';

import { useState } from 'react';
import { OctagonX, Power } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, relativeTime } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { ErrorState, Section } from '../primitives';
import { ReasonDialog } from './reason-dialog';
import { ScopedKillForm } from './scoped-kill-form';
import type { KillLevel, KillSwitchEntry, SetKillSwitchBody } from './types';
import { useKillSwitch } from './use-kill-switch';

// Spec 12 / 16.4 — the four kill-switch levels: global, workspace freeze, project, provider.
// Engaging the global switch halts every Studio job on the platform, so it needs a typed
// confirmation as well as a reason.

export const GLOBAL_CONFIRM_PHRASE = 'HALT ALL STUDIO';

type Pending =
  | { kind: 'global'; enabled: boolean }
  | { kind: 'release'; level: Exclude<KillLevel, 'global'>; target: string }
  | null;

const SCOPED: Array<{
  level: Exclude<KillLevel, 'global'>;
  key: 'frozenWorkspaces' | 'killedProjects' | 'disabledProviders';
  title: string;
  empty: string;
}> = [
  {
    level: 'workspace',
    key: 'frozenWorkspaces',
    title: 'Frozen workspaces',
    empty: 'No workspaces frozen.',
  },
  {
    level: 'project',
    key: 'killedProjects',
    title: 'Killed projects',
    empty: 'No projects killed.',
  },
  {
    level: 'provider',
    key: 'disabledProviders',
    title: 'Disabled providers',
    empty: 'Every provider is enabled.',
  },
];

function EntryList({
  entries,
  empty,
  onRelease,
}: {
  entries: KillSwitchEntry[];
  empty: string;
  onRelease: (id: string) => void;
}) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border/70">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm">{e.id}</span>
            <span className="text-xs text-muted-foreground" title={formatDate(e.since)}>
              since {relativeTime(e.since)}
            </span>
          </span>
          <Button size="sm" variant="outline" onClick={() => onRelease(e.id)}>
            Release<span className="sr-only"> {e.id}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function KillSwitchPanel() {
  const { data, error, isLoading, mutate, set } = useKillSwitch();
  const [pending, setPending] = useState<Pending>(null);

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return <Skeleton aria-label="Loading kill switch" className="h-64 rounded-xl" />;

  const halted = data.global.enabled;
  const confirm = (reason: string) => {
    if (!pending) return Promise.resolve(false);
    const body: SetKillSwitchBody =
      pending.kind === 'global'
        ? { level: 'global', enabled: pending.enabled, reason }
        : { level: pending.level, target: pending.target, enabled: false, reason };
    return set(body);
  };

  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="global-kill"
        className={cn(
          'flex flex-wrap items-center justify-between gap-6 rounded-2xl border p-6',
          halted ? 'border-destructive/40 bg-destructive/8' : 'border-border bg-card',
        )}
      >
        <div className="flex items-start gap-4">
          <span
            className={cn(
              'grid size-12 shrink-0 place-items-center rounded-full',
              halted ? 'bg-destructive text-white' : 'bg-success/15 text-success',
            )}
          >
            {halted ? <OctagonX className="size-6" /> : <Power className="size-6" />}
          </span>
          <div>
            <h2 id="global-kill" className="font-display text-3xl leading-tight">
              {halted ? 'Studio is halted' : 'Studio is running'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {halted
                ? `Global kill switch engaged ${relativeTime(data.global.since)}. No jobs start anywhere.`
                : 'Global kill switch is off.'}{' '}
              Changes reach every worker within {data.propagationSec}s.
            </p>
          </div>
        </div>
        <Button
          variant={halted ? 'default' : 'destructive'}
          onClick={() => setPending({ kind: 'global', enabled: !halted })}
        >
          {halted ? 'Release global kill switch' : 'Engage global kill switch'}
        </Button>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {SCOPED.map((s) => (
          <Section key={s.level} title={s.title} description={`${data[s.key].length} active`}>
            <EntryList
              entries={data[s.key]}
              empty={s.empty}
              onRelease={(target) => setPending({ kind: 'release', level: s.level, target })}
            />
          </Section>
        ))}
      </div>

      <ScopedKillForm onSubmit={set} />

      <ReasonDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.kind === 'global'
            ? pending.enabled
              ? 'Halt all of Studio?'
              : 'Release the global kill switch?'
            : `Release ${pending?.kind === 'release' ? pending.target : ''}?`
        }
        description={
          pending?.kind === 'global' && pending.enabled
            ? 'Every organisation’s Studio jobs stop at their next step: generation, rendering and publishing. In-flight provider calls are not cancelled.'
            : 'Work resumes on the next job start.'
        }
        confirmLabel={pending?.kind === 'global' && pending.enabled ? 'Halt Studio' : 'Release'}
        confirmPhrase={
          pending?.kind === 'global' && pending.enabled ? GLOBAL_CONFIRM_PHRASE : undefined
        }
        destructive={pending?.kind === 'global' && pending.enabled}
        onConfirm={confirm}
      />
    </div>
  );
}

'use client';

import { useState } from 'react';
import { OctagonX, Power } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { ErrorState, Section } from '../primitives';
import { PendingGlobalKillBanner } from './pending-global-kill';
import { ReasonDialog } from './reason-dialog';
import { ScopedKillForm } from './scoped-kill-form';
import type { KillLevel, KillSwitchEntry, SetKillSwitchBody } from './types';
import { useKillSwitch } from './use-kill-switch';

// Spec 12 / 16.4 — the four kill-switch levels: global, workspace freeze, project, provider —
// plus the per-platform publishing halt (Phase 12).
// Engaging the global switch halts every Studio job on the platform, so it needs a typed
// confirmation as well as a reason.

export const GLOBAL_CONFIRM_PHRASE = 'HALT ALL STUDIO';

type Pending =
  | { kind: 'global'; enabled: boolean }
  | { kind: 'release'; level: Exclude<KillLevel, 'global'>; target: string }
  | null;

type ScopedLevel = Exclude<KillLevel, 'global'>;

const SCOPED: Array<{
  level: ScopedLevel;
  key: 'frozenWorkspaces' | 'killedProjects' | 'disabledProviders' | 'disabledPlatforms';
}> = [
  { level: 'workspace', key: 'frozenWorkspaces' },
  { level: 'project', key: 'killedProjects' },
  { level: 'provider', key: 'disabledProviders' },
  { level: 'platform', key: 'disabledPlatforms' },
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
  const t = useTranslations('admin.killSwitch');
  const f = useFormat();
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border/70">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm">{e.id}</span>
            <span className="text-xs text-muted-foreground" title={f.date(e.since)}>
              {t('since', { when: f.relative(e.since) })}
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label={t('releaseAria', { id: e.id })}
            onClick={() => onRelease(e.id)}
          >
            {t('release')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function KillSwitchPanel() {
  const { data, error, isLoading, mutate, set, confirmGlobal, withdrawGlobal } = useKillSwitch();
  const [pending, setPending] = useState<Pending>(null);
  const t = useTranslations('admin.killSwitch');
  const f = useFormat();

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <Skeleton aria-label={t('loading')} className="h-64 rounded-xl" />;

  const halted = data.global.enabled;
  const confirm = (reason: string) => {
    if (!pending) return Promise.resolve(false);
    const body: SetKillSwitchBody =
      pending.kind === 'global'
        ? { level: 'global', enabled: pending.enabled, reason }
        : { level: pending.level, target: pending.target, enabled: false, reason };
    return set(body);
  };

  const pendingGlobal = data.pendingGlobal;

  return (
    <div className="grid gap-10">
      {pendingGlobal && (
        <PendingGlobalKillBanner
          pending={pendingGlobal}
          confirmPhrase={GLOBAL_CONFIRM_PHRASE}
          onConfirm={(reason) => confirmGlobal(pendingGlobal.requestId, reason)}
          onWithdraw={withdrawGlobal}
        />
      )}
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
              halted ? 'bg-destructive text-background' : 'bg-success/15 text-success',
            )}
          >
            {halted ? <OctagonX className="size-6" /> : <Power className="size-6" />}
          </span>
          <div>
            <h2 id="global-kill" className="font-display text-3xl leading-tight">
              {halted ? t('global.halted') : t('global.running')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {halted
                ? t('global.engagedSince', { when: f.relative(data.global.since) })
                : t('global.off')}{' '}
              {t('global.propagation', { seconds: data.propagationSec })}
            </p>
            {!halted && (
              <p className="mt-1 text-xs text-muted-foreground">
                {data.singleApprover ? t('global.breakGlass') : t('global.twoPerson')}
              </p>
            )}
          </div>
        </div>
        <Button
          variant={halted ? 'default' : 'destructive'}
          disabled={!halted && Boolean(pendingGlobal)}
          onClick={() => setPending({ kind: 'global', enabled: !halted })}
        >
          {halted ? t('global.release') : t('global.engage')}
        </Button>
      </section>

      <div className="grid gap-x-6 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
        {SCOPED.map((s) => (
          <Section
            key={s.level}
            title={t(`scoped.${s.level}.title`)}
            description={t('activeCount', { count: (data[s.key] ?? []).length })}
          >
            <EntryList
              entries={data[s.key] ?? []}
              empty={t(`scoped.${s.level}.empty`)}
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
              ? t('dialog.haltTitle')
              : t('dialog.releaseGlobalTitle')
            : t('dialog.releaseTargetTitle', {
                target: pending?.kind === 'release' ? pending.target : '',
              })
        }
        description={
          pending?.kind === 'global' && pending.enabled
            ? data.singleApprover
              ? t('dialog.haltDescription')
              : t('dialog.haltDescriptionTwoPerson')
            : t('dialog.releaseDescription')
        }
        confirmLabel={
          pending?.kind === 'global' && pending.enabled
            ? t('dialog.haltConfirm')
            : t('dialog.releaseConfirm')
        }
        confirmPhrase={
          pending?.kind === 'global' && pending.enabled ? GLOBAL_CONFIRM_PHRASE : undefined
        }
        destructive={pending?.kind === 'global' && pending.enabled}
        onConfirm={confirm}
      />
    </div>
  );
}

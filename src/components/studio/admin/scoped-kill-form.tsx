'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { MIN_REASON } from './reason-dialog';
import { PROVIDER_IDS, PUBLISH_PLATFORMS, type KillLevel, type SetKillSwitchBody } from './types';

// Engage a scoped switch: freeze a workspace (organisation id), kill a project, disable a
// provider, or halt publishing to one platform. The global level has its own typed-confirmation
// control above.

type ScopedLevel = Exclude<KillLevel, 'global'>;

const LEVELS: Array<{ value: ScopedLevel; label: string; target: string }> = [
  { value: 'workspace', label: 'Freeze a workspace', target: 'Organisation id' },
  { value: 'project', label: 'Kill a project', target: 'Project id' },
  { value: 'provider', label: 'Disable a provider', target: 'Provider' },
  { value: 'platform', label: 'Halt publishing to a platform', target: 'Platform' },
];

const TARGET_OPTIONS: Partial<Record<ScopedLevel, { prompt: string; ids: readonly string[] }>> = {
  provider: { prompt: 'Choose a provider', ids: PROVIDER_IDS },
  platform: { prompt: 'Choose a platform', ids: PUBLISH_PLATFORMS },
};

export function ScopedKillForm({
  onSubmit,
}: {
  onSubmit: (body: SetKillSwitchBody) => Promise<boolean>;
}) {
  const [level, setLevel] = useState<ScopedLevel>('workspace');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const meta = LEVELS.find((l) => l.value === level) ?? LEVELS[0];
  const options = TARGET_OPTIONS[level];
  const valid = target.trim().length > 0 && reason.trim().length >= MIN_REASON;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    const done = await onSubmit({
      level,
      target: target.trim(),
      enabled: true,
      reason: reason.trim(),
    });
    setPending(false);
    if (done) {
      setTarget('');
      setReason('');
    }
  };

  return (
    <Section
      title="Engage a scoped switch"
      description="Stops new jobs for one workspace, project or provider, or new uploads to one platform. Nothing else is affected."
    >
      <form
        onSubmit={submit}
        aria-label="Engage a scoped kill switch"
        className="grid gap-3 md:grid-cols-[12rem_14rem_1fr_auto] md:items-end"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="kill-level">Level</Label>
          <select
            id="kill-level"
            className={selectClass}
            value={level}
            onChange={(e) => {
              setLevel(e.target.value as ScopedLevel);
              setTarget('');
            }}
          >
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="kill-target">{meta?.target}</Label>
          {options ? (
            <select
              id="kill-target"
              className={selectClass}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{options.prompt}</option>
              {options.ids.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="kill-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              maxLength={128}
              autoComplete="off"
              className="font-mono"
            />
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="kill-scoped-reason">Reason</Label>
          <Input
            id="kill-scoped-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Recorded in the audit log"
          />
        </div>
        <Button type="submit" variant="destructive" disabled={!valid || pending}>
          {pending && <Loader2 className="animate-spin" />}
          Engage
        </Button>
      </form>
    </Section>
  );
}

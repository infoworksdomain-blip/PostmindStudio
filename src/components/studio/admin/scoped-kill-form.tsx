'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Section } from '../primitives';
import { MIN_REASON } from './reason-dialog';
import { PROVIDER_IDS, PUBLISH_PLATFORMS, type KillLevel, type SetKillSwitchBody } from './types';

// Engage a scoped switch: freeze a workspace (organisation id), kill a project, disable a
// provider, or halt publishing to one platform. The global level has its own typed-confirmation
// control above.

type ScopedLevel = Exclude<KillLevel, 'global'>;

const LEVELS: readonly ScopedLevel[] = ['workspace', 'project', 'provider', 'platform'];

const TARGET_OPTIONS: Partial<Record<ScopedLevel, readonly string[]>> = {
  provider: PROVIDER_IDS,
  platform: PUBLISH_PLATFORMS,
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
  const t = useTranslations('admin.killSwitch.form');
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
    <Section title={t('title')} description={t('description')}>
      <form
        onSubmit={submit}
        aria-label={t('aria')}
        className="grid gap-3 md:grid-cols-[12rem_14rem_1fr_auto] md:items-end"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="kill-level">{t('level')}</Label>
          <NativeSelect
            id="kill-level"
            value={level}
            onChange={(e) => {
              setLevel(e.target.value as ScopedLevel);
              setTarget('');
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {t(`levels.${l}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="kill-target">{t(`targets.${level}`)}</Label>
          {options ? (
            <NativeSelect
              id="kill-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">
                {t(`choose.${level === 'platform' ? 'platform' : 'provider'}`)}
              </option>
              {options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </NativeSelect>
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
          <Label htmlFor="kill-scoped-reason">{t('reason')}</Label>
          <Input
            id="kill-scoped-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder={t('reasonPlaceholder')}
          />
        </div>
        <Button type="submit" variant="destructive" disabled={!valid} loading={pending}>
          {t('engage')}
        </Button>
      </form>
    </Section>
  );
}

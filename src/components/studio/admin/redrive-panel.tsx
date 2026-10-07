'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { Section } from '../primitives';
import { RedriveResults } from './redrive-results';
import type { KillLevel, RedriveBody, RedriveResponse } from './types';

// Phase 12 — bulk re-drive (POST /admin/redrive). Preview is a dry run; Apply repeats the exact
// same filters with dryRun: false after a confirmation. Apply is only offered for the filters
// that were previewed, so the operator always sees what will run first.

const LEVELS: KillLevel[] = ['global', 'workspace', 'project', 'provider', 'platform'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** `<input type="datetime-local">` value for a time, in the browser's zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

interface Filters {
  scope: RedriveBody['scope'];
  level: KillLevel | '';
  since: string;
  stuckMinutes: string;
  organisationId: string;
  limit: string;
}

export function buildBody(f: Filters, dryRun: boolean): RedriveBody {
  const org = f.organisationId.trim();
  const common = { dryRun, limit: Number(f.limit), ...(org && { organisationId: org }) };
  return f.scope === 'stuck'
    ? { scope: 'stuck', stuckMinutes: Number(f.stuckMinutes), ...common }
    : {
        scope: 'kill_switch',
        since: new Date(f.since).toISOString(),
        ...(f.level && { level: f.level }),
        ...common,
      };
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export function RedrivePanel() {
  const [filters, setFilters] = useState<Filters>(() => ({
    scope: 'kill_switch',
    level: '',
    since: toLocalInput(Date.now() - DAY_MS),
    stuckMinutes: '30',
    organisationId: '',
    limit: '100',
  }));
  const [result, setResult] = useState<RedriveResponse | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const t = useTranslations('admin.redrive');
  const tc = useTranslations('common.actions');
  const errorMessage = useErrorMessage();
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const validSince = filters.scope === 'stuck' || !Number.isNaN(Date.parse(filters.since));
  const key = JSON.stringify(filters);
  const canApply =
    previewed === key && result?.dryRun === true && (result?.counts.redriven ?? 0) > 0;

  const send = async (dryRun: boolean): Promise<boolean> => {
    setPending(true);
    try {
      const res = await api<RedriveResponse>('/admin/redrive', {
        method: 'POST',
        body: buildBody(filters, dryRun),
        idempotencyKey: newIdempotencyKey(),
      });
      setResult(res);
      setPreviewed(dryRun ? key : null);
      if (!dryRun) toast.success(t('done', { count: res.counts.redriven }));
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  };

  const preview = (e: FormEvent) => {
    e.preventDefault();
    if (validSince && !pending) void send(true);
  };

  return (
    <div className="grid gap-10">
      <Section title={t('title')} description={t('description')}>
        <form
          onSubmit={preview}
          aria-label={t('formAria')}
          className="grid gap-3 md:grid-cols-3 lg:grid-cols-6 md:items-end"
        >
          <Field id="redrive-scope" label={t('scope')}>
            <NativeSelect
              id="redrive-scope"
              value={filters.scope}
              onChange={(e) => set({ scope: e.target.value as Filters['scope'] })}
            >
              <option value="kill_switch">{t('scopes.killSwitch')}</option>
              <option value="stuck">{t('scopes.stuck')}</option>
            </NativeSelect>
          </Field>
          {filters.scope === 'kill_switch' ? (
            <>
              <Field id="redrive-level" label={t('level')}>
                <NativeSelect
                  id="redrive-level"
                  value={filters.level}
                  onChange={(e) => set({ level: e.target.value as Filters['level'] })}
                >
                  <option value="">{t('anyLevel')}</option>
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`levels.${l}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="redrive-since" label={t('since')}>
                <Input
                  id="redrive-since"
                  type="datetime-local"
                  value={filters.since}
                  onChange={(e) => set({ since: e.target.value })}
                />
              </Field>
            </>
          ) : (
            <Field id="redrive-stuck" label={t('idleMinutes')}>
              <Input
                id="redrive-stuck"
                type="number"
                min={10}
                value={filters.stuckMinutes}
                onChange={(e) => set({ stuckMinutes: e.target.value })}
              />
            </Field>
          )}
          <Field id="redrive-org" label={t('organisation')}>
            <Input
              id="redrive-org"
              value={filters.organisationId}
              onChange={(e) => set({ organisationId: e.target.value })}
              placeholder={t('allOrganisations')}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Field id="redrive-limit" label={t('limit')}>
            <Input
              id="redrive-limit"
              type="number"
              min={1}
              max={500}
              value={filters.limit}
              onChange={(e) => set({ limit: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="outline" disabled={!validSince} loading={pending}>
              {t('preview')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!canApply || pending}
              onClick={() => setConfirming(true)}
            >
              {tc('apply')}
            </Button>
          </div>
        </form>
        {previewed !== null && previewed !== key && (
          <p className="mt-3 text-xs text-muted-foreground">{t('stale')}</p>
        )}
      </Section>

      {result && <RedriveResults result={result} />}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle', { count: result?.counts.redriven ?? 0 })}
        description={t('confirmDescription')}
        confirmLabel={t('confirmLabel')}
        onConfirm={() => send(false)}
      />
    </div>
  );
}

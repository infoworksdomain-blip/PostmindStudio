'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { ReasonDialog } from './reason-dialog';

// BACKLOG 15.D1 / Addendum A12.4 — "Any feature can be disabled per-org or globally within 60
// seconds via SystemFlag toggle". GET|PUT /admin/features. Other processes pick a change up
// within propagationSec (30 s flag cache).

export const FEATURE_NAMES = ['library', 'overlays', 'slideshow', 'image-library'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Feature id → catalogue key under admin.features.names. */
const FEATURE_KEY = {
  library: 'library',
  overlays: 'overlays',
  slideshow: 'slideshow',
  'image-library': 'imageLibrary',
} as const satisfies Record<FeatureName, string>;

export interface FeaturesResponse {
  features: Record<FeatureName, { global: boolean; environment: boolean; disabledFor: string[] }>;
  propagationSec: number;
}

export interface FeatureChange {
  feature: FeatureName;
  scope: 'global' | 'organisation';
  organisationId?: string;
  enabled: boolean;
}

export function FeaturesPanel() {
  const { data, error, isLoading, mutate } = useApi<FeaturesResponse>('/admin/features');
  const [change, setChange] = useState<FeatureChange | null>(null);
  const [orgFeature, setOrgFeature] = useState<FeatureName>('library');
  const [orgId, setOrgId] = useState('');
  const t = useTranslations('admin.features');
  const tc = useTranslations('common.states');
  const errorMessage = useErrorMessage();
  const label = (feature: FeatureName) => t(`names.${FEATURE_KEY[feature]}`);
  const describe = (c: FeatureChange): string => {
    const feature = label(c.feature);
    if (c.scope === 'global')
      return c.enabled ? t('change.onGlobal', { feature }) : t('change.offGlobal', { feature });
    const organisation = c.organisationId ?? '';
    return c.enabled
      ? t('change.onOrg', { feature, organisation })
      : t('change.offOrg', { feature, organisation });
  };

  const apply = async (reason: string): Promise<boolean> => {
    if (!change) return false;
    try {
      const next = await api<FeaturesResponse>('/admin/features', {
        method: 'PUT',
        body: { ...change, reason },
        idempotencyKey: newIdempotencyKey(),
      });
      await mutate(next, { revalidate: false });
      toast.success(t('applied', { change: describe(change), seconds: next.propagationSec }));
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const disableForOrg = (e: FormEvent) => {
    e.preventDefault();
    const id = orgId.trim();
    if (!id) return;
    setChange({ feature: orgFeature, scope: 'organisation', organisationId: id, enabled: false });
  };

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <Skeleton aria-label={t('loading')} className="h-48 rounded-xl" />;

  return (
    <div className="grid gap-6">
      <Section title={t('title')} description={t('description', { seconds: data.propagationSec })}>
        <ul className="grid gap-3">
          {FEATURE_NAMES.map((feature) => {
            const state = data.features[feature];
            const on = state.global && state.environment;
            return (
              <li key={feature} className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{label(feature)}</span>
                    <Badge variant={on ? 'secondary' : 'destructive'}>
                      {on ? tc('on') : tc('off')}
                    </Badge>
                    {!state.environment && <Badge variant="outline">{t('offByEnvironment')}</Badge>}
                  </div>
                  <Button
                    size="sm"
                    variant={state.global ? 'destructive' : 'default'}
                    onClick={() => setChange({ feature, scope: 'global', enabled: !state.global })}
                  >
                    {state.global ? t('turnOffGlobally') : t('turnOnGlobally')}
                  </Button>
                </div>
                {state.disabledFor.length > 0 && (
                  <ul
                    aria-label={t('disabledForAria', { feature: label(feature) })}
                    className="grid gap-1"
                  >
                    {state.disabledFor.map((org) => (
                      <li key={org} className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-mono">{org}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setChange({
                              feature,
                              scope: 'organisation',
                              organisationId: org,
                              enabled: true,
                            })
                          }
                        >
                          {t('turnBackOn')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={t('orgTitle')}>
        <form onSubmit={disableForOrg} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="feature-org-feature">{t('featureLabel')}</Label>
            <select
              id="feature-org-feature"
              className={selectClass}
              value={orgFeature}
              onChange={(e) => setOrgFeature(e.target.value as FeatureName)}
            >
              {FEATURE_NAMES.map((f) => (
                <option key={f} value={f}>
                  {label(f)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="feature-org-id">{t('organisationId')}</Label>
            <Input
              id="feature-org-id"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              maxLength={128}
            />
          </div>
          <Button type="submit" variant="destructive" disabled={!orgId.trim()}>
            {t('turnOff')}
          </Button>
        </form>
      </Section>
      <ReasonDialog
        open={change !== null}
        onOpenChange={(open) => !open && setChange(null)}
        title={change ? describe(change) : ''}
        description={t('dialogDescription')}
        confirmLabel={change?.enabled ? t('turnOn') : t('turnOff')}
        destructive={change ? !change.enabled : false}
        confirmPhrase={
          change && change.scope === 'global' && !change.enabled ? change.feature : undefined
        }
        onConfirm={apply}
      />
    </div>
  );
}

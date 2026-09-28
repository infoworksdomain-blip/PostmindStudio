'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { ReasonDialog } from './reason-dialog';

// BACKLOG 15.D1 / Addendum A12.4 — "Any feature can be disabled per-org or globally within 60
// seconds via SystemFlag toggle". GET|PUT /admin/features. Other processes pick a change up
// within propagationSec (30 s flag cache).

export const FEATURE_NAMES = ['library', 'overlays', 'slideshow', 'image-library'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export const FEATURE_LABEL: Record<FeatureName, string> = {
  library: 'Reference video library',
  overlays: 'Text overlays',
  slideshow: 'Slideshows',
  'image-library': 'Image library',
};

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

function describe(change: FeatureChange): string {
  const what = FEATURE_LABEL[change.feature];
  const where =
    change.scope === 'global' ? 'for every organisation' : `for ${change.organisationId}`;
  return `${change.enabled ? 'Turn on' : 'Turn off'} ${what} ${where}`;
}

export function FeaturesPanel() {
  const { data, error, isLoading, mutate } = useApi<FeaturesResponse>('/admin/features');
  const [change, setChange] = useState<FeatureChange | null>(null);
  const [orgFeature, setOrgFeature] = useState<FeatureName>('library');
  const [orgId, setOrgId] = useState('');

  const apply = async (reason: string): Promise<boolean> => {
    if (!change) return false;
    try {
      const next = await api<FeaturesResponse>('/admin/features', {
        method: 'PUT',
        body: { ...change, reason },
        idempotencyKey: newIdempotencyKey(),
      });
      await mutate(next, { revalidate: false });
      toast.success(`${describe(change)}: applies everywhere within ${next.propagationSec} s`);
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
  if (isLoading || !data)
    return <Skeleton aria-label="Loading features" className="h-48 rounded-xl" />;

  return (
    <div className="grid gap-6">
      <Section
        title="Features"
        description={`Switch a feature off globally or for one organisation. Changes reach every worker and API process within ${data.propagationSec} seconds.`}
      >
        <ul className="grid gap-3">
          {FEATURE_NAMES.map((feature) => {
            const state = data.features[feature];
            const on = state.global && state.environment;
            return (
              <li key={feature} className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{FEATURE_LABEL[feature]}</span>
                    <Badge variant={on ? 'secondary' : 'destructive'}>{on ? 'On' : 'Off'}</Badge>
                    {!state.environment && (
                      <Badge variant="outline">Off by environment (FEATURE_*_ENABLED)</Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={state.global ? 'destructive' : 'default'}
                    onClick={() => setChange({ feature, scope: 'global', enabled: !state.global })}
                  >
                    {state.global ? 'Turn off globally' : 'Turn on globally'}
                  </Button>
                </div>
                {state.disabledFor.length > 0 && (
                  <ul aria-label={`${FEATURE_LABEL[feature]} disabled for`} className="grid gap-1">
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
                          Turn back on
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
      <Section title="Disable for one organisation">
        <form onSubmit={disableForOrg} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="feature-org-feature">Feature</Label>
            <select
              id="feature-org-feature"
              className={selectClass}
              value={orgFeature}
              onChange={(e) => setOrgFeature(e.target.value as FeatureName)}
            >
              {FEATURE_NAMES.map((f) => (
                <option key={f} value={f}>
                  {FEATURE_LABEL[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="feature-org-id">Organisation id</Label>
            <Input
              id="feature-org-id"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              maxLength={128}
            />
          </div>
          <Button type="submit" variant="destructive" disabled={!orgId.trim()}>
            Turn off
          </Button>
        </form>
      </Section>
      <ReasonDialog
        open={change !== null}
        onOpenChange={(open) => !open && setChange(null)}
        title={change ? describe(change) : ''}
        description="Users of this feature get a “feature disabled” error and its background jobs stop until it is turned back on."
        confirmLabel={change?.enabled ? 'Turn on' : 'Turn off'}
        destructive={change ? !change.enabled : false}
        confirmPhrase={
          change && change.scope === 'global' && !change.enabled ? change.feature : undefined
        }
        onConfirm={apply}
      />
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ErrorState, Section } from '../../primitives';
import type { AdminEntitlementsResponse } from '../../billing/types';
import { EntitlementsSummary, type EntitlementView as View } from './entitlements-summary';
import { ClearOverride, OverrideForm } from './override-form';

// Phase 18 §P.3 / §P.4 — staff entitlement overrides for one organisation
// (GET|PUT|DELETE /admin/organisations/:id/entitlements): the effective plan, the trial, the
// stored row, the current override, subscriptions; a form to set tier, access, the plan
// (26.1: Starter / Growth / Pro and weekly / monthly / yearly, not for ENTERPRISE), custom limits, the
// ENTERPRISE agreed monthly price (checked live against the minimum for the organisation's
// monthly cost cap, and blocked here before the server's 422), an optional expiry, "End the trial
// now" (20.27) and a required reason; and removing the override (reason required). Access
// none / read-only, ending a trial and removing the override ask for confirmation first. Every
// change is audited server side. The form lives in override-form.tsx, its field groups in
// entitlement-fields.tsx.

function useEntitlements(orgId: string) {
  const path = `/admin/organisations/${encodeURIComponent(orgId)}/entitlements`;
  const res = useApi<AdminEntitlementsResponse>(path);
  const update = (next: View) => void res.mutate({ entitlements: next }, { revalidate: false });
  return { path, res, update };
}

/** Remount the form after every save so its fields start empty again. */
const formKey = (view: View) => `${view.admin?.setAt ?? 'none'}:${view.trial?.endedAt ?? ''}`;

/** One organisation's plan: the summary, the override form and removing the override. */
export function EntitlementsDetail({ orgId }: { orgId: string }) {
  const t = useTranslations('billing.admin.entitlements');
  const { path, res, update } = useEntitlements(orgId);
  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label={t('loading')} className="h-48" />;
  const view = res.data.entitlements;
  return (
    <div className="grid min-w-0 gap-x-8 gap-y-10 lg:grid-cols-2">
      <Section title={t('effective')}>
        <EntitlementsSummary view={view} />
      </Section>
      <div className="grid min-w-0 gap-10">
        <Section title={t('form.title')}>
          <OverrideForm key={formKey(view)} view={view} path={path} onSaved={update} />
        </Section>
        {view.admin && (
          <Section title={t('clear.title')}>
            <ClearOverride view={view} path={path} onCleared={update} />
          </Section>
        )}
      </div>
    </div>
  );
}

/**
 * 20.27: the organisation page's "Plan, access and trial" section, one card beside Cost caps
 * (same Section pattern): the plan and trial, the override form, and removing the override.
 */
export function PlanOverrideSection({ orgId }: { orgId: string }) {
  const t = useTranslations('billing.admin.entitlements');
  const tOrg = useTranslations('adminOrgs.detail');
  const { path, res, update } = useEntitlements(orgId);
  const view = res.data?.entitlements;
  return (
    <Section title={tOrg('planTitle')} description={tOrg('planHint')}>
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !view ? (
        <Skeleton aria-label={t('loading')} className="h-48" />
      ) : (
        <div className="grid min-w-0 gap-6">
          <EntitlementsSummary view={view} />
          <div className="grid gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">{t('form.title')}</h3>
            <OverrideForm key={formKey(view)} view={view} path={path} onSaved={update} />
          </div>
          {view.admin && (
            <div className="grid gap-3 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">{t('clear.title')}</h3>
              <ClearOverride view={view} path={path} onCleared={update} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

export function EntitlementsPanel() {
  const t = useTranslations('billing.admin.entitlements');
  const [input, setInput] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOrgId(input.trim() || null);
        }}
      >
        <div className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor="ent-org-lookup">{t('orgIdLabel')}</Label>
          <Input
            id="ent-org-lookup"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('orgIdPlaceholder')}
            className="w-full sm:w-72"
            maxLength={128}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!input.trim()}>
          {t('open')}
        </Button>
      </form>
      {orgId && <EntitlementsDetail key={orgId} orgId={orgId} />}
    </div>
  );
}

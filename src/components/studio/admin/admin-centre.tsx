'use client';

import { ShieldAlert } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/client/api';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { CostReportPanel } from './cost-report-panel';
import { DeadLetterPanel } from './dead-letter-panel';
import { FeaturesPanel } from './features-panel';
import { ForceApprovalsPanel } from './force-approvals-panel';
import { KillSwitchPanel } from './kill-switch-panel';
import { LibraryAdminPanel } from './library-admin-panel';
import { RedrivePanel } from './redrive-panel';
import { ProvidersPanel, QueuesPanel } from './health-panels';
import { OrganisationPanel } from './organisation-panel';
import { SafetyReviewPanel } from './safety-review-panel';
import { UsagePanel } from './usage-panel';
import { isForbidden, type KillSwitchState } from './types';

// BACKLOG 10.11 / spec 16.4 — Admin Centre (PostMind staff only). Every /admin route calls
// requirePlatformStaff and answers 403 to anyone else, so the kill-switch read doubles as the
// access probe: a 403 shows the staff-only state instead of three failing tabs.

export function StaffOnly() {
  return (
    <EmptyState
      icon={<ShieldAlert className="size-8" strokeWidth={1.5} />}
      title="PostMind staff only"
      description="The Admin Centre controls the whole platform — kill switches, the reference corpus and provider spend. Your account isn’t on the platform staff list."
    />
  );
}

const TABS = [
  'kill-switch',
  'features',
  'redrive',
  'library',
  'cost',
  'queues',
  'providers',
  'safety',
  'organisations',
  'usage',
  'dead-letters',
  'force-approvals',
] as const;

export function AdminCentre() {
  const probe = useApi<KillSwitchState>('/admin/kill-switch');
  // ?tab= opens a tab directly (the safety-review notification links to ?tab=safety).
  const requested = useSearchParams()?.get('tab') ?? '';
  const initialTab = (TABS as readonly string[]).includes(requested) ? requested : 'kill-switch';
  const header = (
    <PageHeader
      eyebrow="PostMind staff"
      title="Admin Centre"
      description="Platform-wide controls for Studio. Every change here is audited."
    />
  );

  if (isForbidden(probe.error))
    return (
      <>
        {header}
        <StaffOnly />
      </>
    );
  if (probe.error)
    return (
      <>
        {header}
        <ErrorState error={probe.error} onRetry={() => void probe.mutate()} />
      </>
    );
  if (probe.isLoading || !probe.data)
    return (
      <>
        {header}
        <Skeleton aria-label="Checking access" className="h-64 rounded-xl" />
      </>
    );

  return (
    <>
      {header}
      <Tabs defaultValue={initialTab} className="min-w-0 gap-6">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="kill-switch">Kill switch</TabsTrigger>
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="redrive">Re-drive</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="cost">Cost report</TabsTrigger>
          <TabsTrigger value="queues">Queues</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="safety">Safety review</TabsTrigger>
          <TabsTrigger value="organisations">Organisations</TabsTrigger>
          <TabsTrigger value="usage">Plan usage</TabsTrigger>
          <TabsTrigger value="dead-letters">Dead letters</TabsTrigger>
          <TabsTrigger value="force-approvals">Force-approvals</TabsTrigger>
        </TabsList>
        <TabsContent value="kill-switch">
          <KillSwitchPanel />
        </TabsContent>
        <TabsContent value="features">
          <FeaturesPanel />
        </TabsContent>
        <TabsContent value="redrive">
          <RedrivePanel />
        </TabsContent>
        <TabsContent value="library">
          <LibraryAdminPanel />
        </TabsContent>
        <TabsContent value="cost">
          <CostReportPanel />
        </TabsContent>
        <TabsContent value="queues">
          <QueuesPanel />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersPanel />
        </TabsContent>
        <TabsContent value="safety">
          <SafetyReviewPanel />
        </TabsContent>
        <TabsContent value="organisations">
          <OrganisationPanel />
        </TabsContent>
        <TabsContent value="usage">
          <UsagePanel />
        </TabsContent>
        <TabsContent value="dead-letters">
          <DeadLetterPanel />
        </TabsContent>
        <TabsContent value="force-approvals">
          <ForceApprovalsPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}

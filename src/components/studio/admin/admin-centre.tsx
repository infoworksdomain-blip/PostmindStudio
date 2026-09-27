'use client';

import { ShieldAlert } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/client/api';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { CostReportPanel } from './cost-report-panel';
import { KillSwitchPanel } from './kill-switch-panel';
import { LibraryAdminPanel } from './library-admin-panel';
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

export function AdminCentre() {
  const probe = useApi<KillSwitchState>('/admin/kill-switch');
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
      <Tabs defaultValue="kill-switch" className="min-w-0 gap-6">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="kill-switch">Kill switch</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="cost">Cost report</TabsTrigger>
        </TabsList>
        <TabsContent value="kill-switch">
          <KillSwitchPanel />
        </TabsContent>
        <TabsContent value="library">
          <LibraryAdminPanel />
        </TabsContent>
        <TabsContent value="cost">
          <CostReportPanel />
        </TabsContent>
      </Tabs>
      <p className="mt-10 text-xs text-muted-foreground">
        Not available yet (no admin API): queue health, provider health and the content-safety
        review queue from spec 16.4.
      </p>
    </>
  );
}

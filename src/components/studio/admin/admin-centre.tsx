'use client';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/client/api';
import { useMe } from '../account/use-me';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { CostReportPanel } from './cost-report-panel';
import { DeadLetterPanel } from './dead-letter-panel';
import { FeaturesPanel } from './features-panel';
import { ForceApprovalsPanel } from './force-approvals-panel';
import { KillSwitchPanel } from './kill-switch-panel';
import { LibraryAdminPanel } from './library-admin-panel';
import { RedrivePanel } from './redrive-panel';
import { ProvidersPanel, QueuesPanel } from './health-panels';
import { LegalReadinessWarning } from './legal-readiness-warning';
import { OrganisationsTab } from './organisations/organisations-tab';
import { SubscriptionsTab } from './subscriptions/subscriptions-tab';
import { UsersTab } from './users/users-tab';
import { SafetyReviewPanel } from './safety-review-panel';
import { UsagePanel } from './usage-panel';
import { BetaPanel } from './beta-panel';
import { SafetyAuditPanel } from './safety-audit-panel';
import { AdminBillingTab } from './billing/billing-tab';
import { isForbidden, type KillSwitchState } from './types';

// BACKLOG 10.11 / spec 16.4 — Admin Centre (PostMind staff only). Every /admin route calls
// requirePlatformStaff and answers 403 to anyone else, so the kill-switch read doubles as the
// access probe: a 403 shows the staff-only state instead of three failing tabs.

export function StaffOnly() {
  const t = useTranslations('admin.centre.staffOnly');
  // Staff and superadmins get a 403 only while 2FA is off (capabilitiesForPlatformRole), so tell
  // them that instead of "not on the staff list".
  const platformRole = useMe().data?.me?.user?.platformRole;
  if (platformRole === 'staff' || platformRole === 'superadmin')
    return (
      <EmptyState
        icon={<ShieldAlert className="size-8" strokeWidth={1.5} />}
        title={t('needs2faTitle')}
        description={t('needs2faDescription')}
        action={
          <Link
            href="/account/security"
            className="font-medium underline underline-offset-4 hover:no-underline"
          >
            {t('needs2faAction')}
          </Link>
        }
      />
    );
  return (
    <EmptyState
      icon={<ShieldAlert className="size-8" strokeWidth={1.5} />}
      title={t('title')}
      description={t('description')}
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
  'safety-audit',
  'organisations',
  // Phase 18: the standalone directory tabs.
  'users',
  'subscriptions',
  'usage',
  'dead-letters',
  'force-approvals',
  'beta',
] as const;

type Tab = (typeof TABS)[number];

// Tab value (URL ?tab=) → catalogue key under admin.centre.tabs.
const TAB_KEY = {
  'kill-switch': 'killSwitch',
  features: 'features',
  redrive: 'redrive',
  library: 'library',
  cost: 'cost',
  queues: 'queues',
  providers: 'providers',
  safety: 'safety',
  'safety-audit': 'safetyAudit',
  organisations: 'organisations',
  users: 'users',
  subscriptions: 'subscriptions',
  usage: 'usage',
  'dead-letters': 'deadLetters',
  'force-approvals': 'forceApprovals',
  beta: 'beta',
} as const satisfies Record<Tab, string>;

export function AdminCentre() {
  const t = useTranslations('admin.centre');
  const tBilling = useTranslations('billing.admin');
  const probe = useApi<KillSwitchState>('/admin/kill-switch');
  // ?tab= opens a tab directly (the safety-review notification links to ?tab=safety).
  const requested = useSearchParams()?.get('tab') ?? '';
  const initialTab = ([...TABS, 'billing'] as readonly string[]).includes(requested)
    ? requested
    : 'kill-switch';
  const header = (
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
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
        <Skeleton aria-label={t('checkingAccess')} className="h-64 rounded-xl" />
      </>
    );

  return (
    <>
      {header}
      <LegalReadinessWarning />
      <Tabs defaultValue={initialTab} className="min-w-0 gap-6">
        {/* 18 tabs do not fit one row: a centred, scrolling row pushed the first tabs (Kill switch,
            Features, Redrive) out of reach under the sidebar at 1280 px (20.10). They wrap. */}
        <TabsList className="h-auto max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto">
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`tabs.${TAB_KEY[tab]}`)}
            </TabsTrigger>
          ))}
          <TabsTrigger value="billing">{tBilling('tab')}</TabsTrigger>
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
          <OrganisationsTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="subscriptions">
          <SubscriptionsTab />
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
        <TabsContent value="safety-audit">
          <SafetyAuditPanel />
        </TabsContent>
        <TabsContent value="beta">
          <BetaPanel />
        </TabsContent>
        <TabsContent value="billing">
          <AdminBillingTab />
        </TabsContent>
      </Tabs>
    </>
  );
}

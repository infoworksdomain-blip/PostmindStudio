'use client';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
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
import { UsersTab } from './users/users-tab';
import { SafetyReviewPanel } from './safety-review-panel';
import { UsagePanel } from './usage-panel';
import { BetaPanel } from './beta-panel';
import { SafetyAuditPanel } from './safety-audit-panel';
import { AdminBillingTab } from './billing/billing-tab';
import { AdminMenu } from './admin-menu';
import { groupOf, SECTION_KEY, type AdminSection, type BillingView } from './admin-sections';
import { useAdminSection } from './use-admin-section';
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
        media={<ShieldAlert className="size-8" strokeWidth={1.5} />}
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
      media={<ShieldAlert className="size-8" strokeWidth={1.5} />}
      title={t('title')}
      description={t('description')}
    />
  );
}

/** Each section's panel. */
function SectionPanel({
  section,
  view,
  onViewChange,
}: {
  section: AdminSection;
  view: BillingView;
  onViewChange: (view: BillingView) => void;
}) {
  switch (section) {
    case 'kill-switch':
      return <KillSwitchPanel />;
    case 'queues':
      return <QueuesPanel />;
    case 'dead-letters':
      return <DeadLetterPanel />;
    case 'redrive':
      return <RedrivePanel />;
    case 'providers':
      return <ProvidersPanel />;
    case 'library':
      return <LibraryAdminPanel />;
    case 'safety':
      return <SafetyReviewPanel />;
    case 'safety-audit':
      return <SafetyAuditPanel />;
    case 'force-approvals':
      return <ForceApprovalsPanel />;
    case 'organisations':
      return <OrganisationsTab />;
    case 'users':
      return <UsersTab />;
    case 'billing':
      return <AdminBillingTab view={view} onViewChange={onViewChange} />;
    case 'usage':
      return <UsagePanel />;
    case 'beta':
      return <BetaPanel />;
    case 'features':
      return <FeaturesPanel />;
    case 'cost':
      return <CostReportPanel />;
  }
}

export function AdminCentre() {
  const t = useTranslations('admin.centre');
  const probe = useApi<KillSwitchState>('/admin/kill-switch');
  // ?tab= (and ?view=) open a section directly — the safety-review notification links to
  // ?tab=safety — and stay in sync with the menu (25.13).
  const { section, view, hrefFor, open } = useAdminSection();
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

  const title = t(`tabs.${SECTION_KEY[section]}`);
  return (
    <>
      {header}
      <LegalReadinessWarning />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <AdminMenu
          current={section}
          hrefFor={hrefFor}
          onOpen={(next) => open(next)}
          halted={probe.data.global.enabled}
        />
        <section
          aria-labelledby="admin-section-title"
          data-section={section}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6"
        >
          <div className="grid gap-0.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t(`menu.groups.${groupOf(section)}`)}
            </p>
            <h2 id="admin-section-title" className="font-display text-xl leading-tight">
              {title}
            </h2>
          </div>
          <SectionPanel
            key={section}
            section={section}
            view={view}
            onViewChange={(next) => open('billing', next)}
          />
        </section>
      </div>
    </>
  );
}

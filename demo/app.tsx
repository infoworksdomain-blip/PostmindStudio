import { ThemeProvider } from 'next-themes';
import { useEffect, useState, type ReactNode } from 'react';
import { AdminCentre } from '@/components/studio/admin/admin-centre';
import { ExportScreen } from '@/components/studio/account/export-screen';
import { ProfileScreen } from '@/components/studio/account/profile-screen';
import { SecurityScreen } from '@/components/studio/account/security/security-screen';
import { PublicPreview } from '@/components/studio/share/public-preview';
import { TemplatesScreen } from '@/components/studio/templates/templates-screen';
import { AnalyticsDashboard } from '@/components/studio/analytics/analytics-dashboard';
import { PublicationAnalytics } from '@/components/studio/analytics/publication-analytics';
import { AppShell } from '@/components/studio/app-shell';
import { BusinessProvider } from '@/components/studio/business-context';
import { BusinessScreen } from '@/components/studio/business/business-screen';
import { PublicationsCalendar } from '@/components/studio/calendar/publications-calendar';
import { PlanMonthForm } from '@/components/studio/plans/plan-month-form';
import { PlanScreen } from '@/components/studio/plans/plan-screen';
import { PlansList } from '@/components/studio/plans/plans-list';
import { AutomationDetailScreen } from '@/components/studio/automations/automation-detail';
import { AutomationsList } from '@/components/studio/automations/automations-list';
import { AutomationWizard } from '@/components/studio/automations/automation-wizard';
import { BlitzScreen } from '@/components/studio/blitz/blitz-screen';
import { ImageStudioScreen } from '@/components/studio/images/image-studio-screen';
import { MediaScreen } from '@/components/studio/media/media-screen';
import { ConnectionsScreen } from '@/components/studio/connections/connections-screen';
import { ApprovalWorkflowsScreen } from '@/components/studio/approvals/approval-workflows-screen';
import { parseReference } from '@/components/studio/create/body';
import { CreateScreen } from '@/components/studio/create/create-screen';
import { LibraryBrowse } from '@/components/studio/library/library-browse';
import { LibraryDetail } from '@/components/studio/library/library-detail';
import { WelcomeWizard } from '@/components/studio/onboarding/welcome-wizard';
import { AuditScreen } from '@/components/studio/settings/audit-screen';
import { MembersScreen } from '@/components/studio/settings/members-screen';
import { OrganisationSettingsScreen } from '@/components/studio/settings/organisation-settings';
import { ProjectsList } from '@/components/studio/projects/projects-list';
import { HomeScreen } from '@/components/studio/home/home-screen';
import { PublicationsList } from '@/components/studio/publications/publications-list';
import { ReviewScreen } from '@/components/studio/review/review-screen';
import { StudioIntlProvider } from '@/components/studio/i18n/intl-provider';
import { BillingScreen } from '@/components/studio/billing/billing-screen';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { LOCALE_COOKIE, resolveLocale, type Locale } from '@/lib/i18n/locales';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEMO_BUSINESS_ID } from './api/ids';
import { useRevalidateOnBillingChange } from './tour/billing-switcher';
import { DemoBar, useSignedIn } from './tour/demo-bar';
import { EmailPreview } from './tour/email-preview';
import { FeaturesPage } from './tour/features';
import { NotBuiltScreen } from './tour/not-built';
import { SystemTour } from './tour/system';
import { TourHome } from './tour/home';
import { WhatsNew } from './tour/whats-new';
import { WorkflowsPage } from './tour/workflows-page';
import { publicPage } from './public-pages';
import { matchPath, navigate, useLocation } from './router';
import { APP_PATHS, isPublicPath, type AppPath } from './routes';
import { onLanguageParam } from './tour-params';

// The demo build: the real Studio screens (src/components/studio) inside the real app shell,
// routed in-page and served by the in-browser sample API (demo/api).

type Render = (params: Record<string, string>, query: URLSearchParams) => ReactNode;

// Every app-shell route (demo/routes.ts APP_PATHS); the Record type makes a missing one an error.
const RENDER: Record<AppPath, Render> = {
  '/tour': () => <TourHome />,
  '/tour/whats-new': () => <WhatsNew />,
  '/tour/system': () => <SystemTour />,
  '/tour/not-built': () => <NotBuiltScreen />,
  '/tour/features': () => <FeaturesPage />,
  '/tour/workflows': () => <WorkflowsPage />,
  '/tour/email/:template': (p) => <EmailPreview template={p.template ?? ''} />,
  '/new': (_p, q) => (
    <CreateScreen
      initialReference={parseReference(q.get('reference') ?? undefined, q.get('mode') ?? undefined)}
    />
  ),
  '/home': () => <HomeScreen />,
  '/projects': () => <ProjectsList />,
  '/projects/:id': (p) => <ReviewScreen projectId={p.id ?? ''} />,
  '/library': () => <LibraryBrowse />,
  '/library/:id': (p) => <LibraryDetail id={p.id ?? ''} />,
  '/publications': () => <PublicationsList />,
  '/calendar': () => <PublicationsCalendar />,
  // 20.9: Plan my month.
  '/plans': () => <PlansList />,
  '/plans/new': () => <PlanMonthForm />,
  '/plans/:id': (p) => <PlanScreen planId={p.id ?? ''} />,
  // 22.4 Blitz, 22.5 Automations.
  '/blitz': () => <BlitzScreen />,
  // 25.8: Image Studio.
  '/images': () => <ImageStudioScreen />,
  // 25.10: My media.
  '/media': () => <MediaScreen />,
  '/automations': () => <AutomationsList />,
  '/automations/new': () => <AutomationWizard />,
  '/automations/:id': (p) => <AutomationDetailScreen automationId={p.id ?? ''} />,
  '/analytics': () => <AnalyticsDashboard />,
  '/analytics/publications/:id': (p) => <PublicationAnalytics publicationId={p.id ?? ''} />,
  '/business': () => <BusinessScreen />,
  '/connections': () => <ConnectionsScreen />,
  '/approvals': () => <ApprovalWorkflowsScreen />,
  '/welcome': () => <WelcomeWizard />,
  '/admin': () => <AdminCentre />,
  '/templates': () => <TemplatesScreen />,
  '/account/export': () => <ExportScreen />,
  // Phase 18 Track A: profile and security (sessions, 2FA, delete the account).
  '/account/profile': () => <ProfileScreen />,
  '/account/security': () => <SecurityScreen googleEnabled />,
  '/p/:token': (p) => <PublicPreview token={p.token ?? ''} />,
  // Phase 18 Track E: organisation settings, members and the audit log.
  '/settings/organisation': () => <OrganisationSettingsScreen />,
  '/settings/members': () => <MembersScreen />,
  '/settings/audit': () => <AuditScreen />,
  // Phase 18 Track C / 21.5: Your plan (channels, changes), usage, video packs and invoices (the
  // demo bar's plan switcher drives them).
  '/settings/billing': () => <BillingScreen />,
};

/** Screens a signed-out visitor may still open (the tour itself and a public share link). */
const OPEN_WHEN_SIGNED_OUT = (pathname: string) =>
  pathname.startsWith('/tour') || pathname.startsWith('/p/');

function Routed() {
  const { pathname, search } = useLocation();
  for (const path of APP_PATHS) {
    const params = matchPath(path, pathname);
    if (params) {
      // Remount per page so each screen starts fresh, as a page navigation would. Query-only
      // changes (e.g. Connections clearing ?connected=) keep the screen mounted, like Next.js;
      // /new is the exception because its query carries the library reference.
      const key = pathname === '/new' ? `${pathname}${search}` : pathname;
      return <div key={key}>{RENDER[path](params, new URLSearchParams(search))}</div>;
    }
  }
  return (
    <div className="mx-auto max-w-xl py-24 text-center">
      <p className="text-muted-foreground text-sm">No screen at {pathname}.</p>
      <a className="text-primary mt-3 inline-block underline" href="#/tour">
        Back to the tour
      </a>
    </div>
  );
}

/** Phase 16: the demo's locale — the saved choice (cookie), else the browser's languages. */
function initialLocale(): Locale {
  const cookie = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  return resolveLocale({
    cookie: cookie ? decodeURIComponent(cookie) : null,
    acceptLanguage: navigator.languages.join(','),
  });
}

export function DemoApp() {
  // Every catalogue ships in the bundle, so the header language switcher swaps locale in place
  // (the app instead refreshes its server tree).
  const [locale, setLocale] = useState<Locale>(initialLocale);
  // A tour link with ?lang= (demo/tour-params.ts) swaps the catalogue in place.
  useEffect(() => onLanguageParam(setLocale), []);
  return (
    <StudioIntlProvider locale={locale} messages={ALL_MESSAGES[locale]} onLocaleChange={setLocale}>
      <DemoShell />
    </StudioIntlProvider>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={200}>
        {children}
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function DemoShell() {
  const { pathname, search } = useLocation();
  const signedIn = useSignedIn();
  useRevalidateOnBillingChange();
  const signedInAtRoot = signedIn && (pathname === '/' || pathname === '');
  const bounceToSignIn = !signedIn && !isPublicPath(pathname) && !OPEN_WHEN_SIGNED_OUT(pathname);
  useEffect(() => {
    // "/" is the landing page; as in the app, a signed-in visitor goes on to Home (25.4).
    if (signedInAtRoot) navigate('/home', { replace: true });
    // The app's page guard sends a signed-out visitor to sign in, then back.
    else if (bounceToSignIn)
      navigate(`/sign-in?next=${encodeURIComponent(`${pathname}${search}`)}`, { replace: true });
  }, [signedInAtRoot, bounceToSignIn, pathname, search]);
  // Phase 18: the public pages (landing at "/", legal, pricing, sign-up / sign-in, the demo
  // checkout) have no app shell.
  const publicBody = publicPage(pathname, new URLSearchParams(search));
  if (publicBody)
    return (
      <Providers>
        <DemoBar />
        {publicBody}
      </Providers>
    );
  // Signed out, the tour pages stay readable, without the app's sidebar and header.
  if (!signedIn)
    return (
      <Providers>
        <DemoBar />
        <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
          {OPEN_WHEN_SIGNED_OUT(pathname) && <Routed />}
        </main>
      </Providers>
    );
  return (
    <Providers>
      <BusinessProvider initial={DEMO_BUSINESS_ID}>
        <DemoBar />
        <AppShell>
          <Routed />
        </AppShell>
      </BusinessProvider>
    </Providers>
  );
}

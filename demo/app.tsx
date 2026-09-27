import { ThemeProvider } from 'next-themes';
import { useEffect, type ReactNode } from 'react';
import { AdminCentre } from '@/components/studio/admin/admin-centre';
import { AnalyticsDashboard } from '@/components/studio/analytics/analytics-dashboard';
import { AppShell } from '@/components/studio/app-shell';
import { BusinessProvider } from '@/components/studio/business-context';
import { BusinessScreen } from '@/components/studio/business/business-screen';
import { PublicationsCalendar } from '@/components/studio/calendar/publications-calendar';
import { ConnectionsScreen } from '@/components/studio/connections/connections-screen';
import { parseReference } from '@/components/studio/create/body';
import { CreateScreen } from '@/components/studio/create/create-screen';
import { LibraryBrowse } from '@/components/studio/library/library-browse';
import { LibraryDetail } from '@/components/studio/library/library-detail';
import { ProjectsList } from '@/components/studio/projects/projects-list';
import { PublicationsList } from '@/components/studio/publications/publications-list';
import { ReviewScreen } from '@/components/studio/review/review-screen';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEMO_BUSINESS_ID } from './api/ids';
import { DemoBar } from './tour/demo-bar';
import { NotBuiltScreen } from './tour/not-built';
import { SystemTour } from './tour/system';
import { TourHome } from './tour/home';
import { matchPath, navigate, useLocation } from './router';

// The demo build: the real Studio screens (src/components/studio) inside the real app shell,
// routed in-page and served by the in-browser sample API (demo/api).

interface RouteDef {
  path: string;
  render: (params: Record<string, string>, query: URLSearchParams) => ReactNode;
}

const ROUTES: RouteDef[] = [
  { path: '/tour', render: () => <TourHome /> },
  { path: '/tour/system', render: () => <SystemTour /> },
  { path: '/tour/not-built', render: () => <NotBuiltScreen /> },
  {
    path: '/new',
    render: (_p, q) => (
      <CreateScreen
        initialReference={parseReference(
          q.get('reference') ?? undefined,
          q.get('mode') ?? undefined,
        )}
      />
    ),
  },
  { path: '/projects', render: () => <ProjectsList /> },
  { path: '/projects/:id', render: (p) => <ReviewScreen projectId={p.id ?? ''} /> },
  { path: '/library', render: () => <LibraryBrowse /> },
  { path: '/library/:id', render: (p) => <LibraryDetail id={p.id ?? ''} /> },
  { path: '/publications', render: () => <PublicationsList /> },
  { path: '/calendar', render: () => <PublicationsCalendar /> },
  { path: '/analytics', render: () => <AnalyticsDashboard /> },
  { path: '/business', render: () => <BusinessScreen /> },
  { path: '/connections', render: () => <ConnectionsScreen /> },
  { path: '/admin', render: () => <AdminCentre /> },
];

function Routed() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (pathname === '/' || pathname === '') navigate('/tour', { replace: true });
  }, [pathname]);
  for (const r of ROUTES) {
    const params = matchPath(r.path, pathname);
    if (params) {
      // Remount per page so each screen starts fresh, as a page navigation would. Query-only
      // changes (e.g. Connections clearing ?connected=) keep the screen mounted, like Next.js;
      // /new is the exception because its query carries the library reference.
      const key = pathname === '/new' ? `${pathname}${search}` : pathname;
      return <div key={key}>{r.render(params, new URLSearchParams(search))}</div>;
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

export function DemoApp() {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={200}>
        <BusinessProvider initial={DEMO_BUSINESS_ID}>
          <DemoBar />
          <AppShell>
            <Routed />
          </AppShell>
        </BusinessProvider>
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
}

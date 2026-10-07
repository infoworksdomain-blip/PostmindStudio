'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { directionOf } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { AccountControls } from './account/account-menu';
import { BusinessSwitcher } from './business-picker';
import { useLocaleSwitch } from './i18n/intl-provider';
import { ThemeMenuButton } from './theme-switcher';
import { NotificationsBell } from './notifications-bell';
import { NoOrganisationRedirect } from './onboarding/no-organisation-redirect';
import { UpgradeDialogHost } from './billing/upgrade-dialog';
import { CommandMenu } from './shell/command-menu';
import { NoticeStrip } from './shell/notice-strip';
import { PageContext, PageTransition } from './shell/page-context';
import { NavList, Sidebar, useSidebarCollapsed, Wordmark } from './shell/sidebar';

// The signed-in app's frame (BACKLOG 25.4): a quiet sidebar (Create / Plan / Library / Insights /
// Settings, an icon rail on desktop), a decluttered top bar (page context on the start side; the
// business, the command menu, notifications and the account menu on the end side), one notice
// strip under it, and the page. Labels come from the `shell` catalogue; layout uses logical
// properties so everything mirrors in RTL (16.2).

export { NAV } from './shell/nav';
export { BusinessSwitcher };

/** 25.2: the compact appearance button (Light / Dark / System; theme-switcher.tsx). 25.4: the top
 * bar no longer shows it (the account menu has the choice); kept for other screens and tests. */
export const ThemeToggle = ThemeMenuButton;

function MobileNav() {
  const t = useTranslations('shell.nav');
  const { locale } = useLocaleSwitch();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('openNavigation')}>
          <Menu />
        </Button>
      </SheetTrigger>
      {/* The drawer opens from the start edge: left in LTR, right in RTL. */}
      <SheetContent
        side={directionOf(locale) === 'rtl' ? 'right' : 'left'}
        className="flex w-72 flex-col gap-0 bg-sidebar p-0"
      >
        <SheetTitle className="sr-only">{t('navigationTitle')}</SheetTitle>
        <div className="grid gap-4 border-b border-sidebar-border p-4 pe-12">
          <Wordmark />
          <BusinessSwitcher placement="drawer" />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <NavList onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  return (
    <div
      className={cn(
        'relative z-10 min-h-dvh lg:grid',
        collapsed ? 'lg:grid-cols-[3.5rem_1fr]' : 'lg:grid-cols-[15rem_1fr]',
      )}
    >
      <NoOrganisationRedirect />
      <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border/70 bg-background/85 px-3 backdrop-blur sm:px-4 md:px-8">
          <MobileNav />
          <div className="lg:hidden">
            <Wordmark compact />
          </div>
          <div className="min-w-0 flex-1 max-sm:hidden">
            <PageContext />
          </div>
          <div className="ms-auto flex min-w-0 items-center gap-1 sm:gap-2">
            <BusinessSwitcher />
            <CommandMenu />
            <NotificationsBell />
            <AccountControls />
          </div>
        </header>
        <NoticeStrip />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8 md:py-10">
          <PageTransition>{children}</PageTransition>
          <UpgradeDialogHost />
        </main>
      </div>
    </div>
  );
}

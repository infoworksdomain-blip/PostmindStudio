'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  Building2,
  CalendarDays,
  Download,
  Clapperboard,
  Film,
  LayoutTemplate,
  Library,
  Link2,
  ListChecks,
  Menu,
  Moon,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { directionOf } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { AccountBanners } from './account/account-banners';
import { AccountControls } from './account/account-menu';
import { BusinessSwitcher } from './business-picker';
import { FeedbackButton } from './feedback-dialog';
import { LanguageSwitcher } from './i18n/language-switcher';
import { useLocaleSwitch } from './i18n/intl-provider';
import { NotificationsBell } from './notifications-bell';
import { UsageBanner } from './usage-meter';
import { WelcomeLink } from './onboarding/welcome-link';
import { UpgradeDialogHost } from './billing/upgrade-dialog';

// Studio's three surfaces (spec 14: create, review, manage) plus Feature A/D and admin screens.
// Labels come from the `shell` catalogue (BACKLOG 16.1); layout uses logical properties so the
// sidebar and header mirror in RTL (16.2).

export const NAV = [
  { href: '/new', key: 'create', icon: Plus, group: 'make' },
  { href: '/projects', key: 'projects', icon: Clapperboard, group: 'make' },
  { href: '/library', key: 'library', icon: Library, group: 'make' },
  { href: '/templates', key: 'templates', icon: LayoutTemplate, group: 'make' },
  { href: '/publications', key: 'publications', icon: Send, group: 'manage' },
  { href: '/calendar', key: 'calendar', icon: CalendarDays, group: 'manage' },
  { href: '/analytics', key: 'analytics', icon: BarChart3, group: 'manage' },
  { href: '/business', key: 'business', icon: Building2, group: 'setup' },
  { href: '/connections', key: 'connections', icon: Link2, group: 'setup' },
  { href: '/approvals', key: 'approvals', icon: ListChecks, group: 'setup' },
  // Phase 18: organisation settings, members and audit (active on every /settings/* page).
  { href: '/settings/organisation', key: 'settings', icon: Settings, group: 'setup' },
  { href: '/account/export', key: 'export', icon: Download, group: 'setup' },
  { href: '/admin', key: 'admin', icon: ShieldAlert, group: 'staff' },
] as const;

function isActive(pathname: string, href: string) {
  if (href.startsWith('/settings/')) return pathname.startsWith('/settings/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations('shell.nav');
  const pathname = usePathname() ?? '';
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav aria-label={t('ariaLabel')} className="flex flex-col gap-6">
      <WelcomeLink onNavigate={onNavigate} />
      {groups.map((group) => (
        <div key={group}>
          <p className="mb-2 px-3 text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            {t(`groups.${group}`)}
          </p>
          <ul className="flex flex-col gap-0.5">
            {NAV.filter((n) => n.group === group).map(({ href, key, icon: Icon }) => {
              const active = isActive(pathname, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                      'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/80',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4',
                        active
                          ? 'text-primary'
                          : 'text-muted-foreground group-hover:text-foreground',
                      )}
                      strokeWidth={1.75}
                    />
                    {t(`items.${key}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** compact: on phones the header shows only the mark (the name stays for screen readers). */
function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/projects" className={cn('flex items-center gap-2', compact ? 'sm:px-3' : 'px-3')}>
      <span className="grid size-7 place-items-center rounded-md bg-foreground text-background">
        <Film className="size-4" strokeWidth={2} />
      </span>
      <span
        className={cn(
          'font-display text-xl leading-none whitespace-nowrap',
          compact && 'max-sm:sr-only',
        )}
      >
        PostMind <em className="text-primary not-italic">Studio</em>
      </span>
    </Link>
  );
}

export { BusinessSwitcher };

function ThemeToggle() {
  const t = useTranslations('shell.theme');
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? t('useLight') : t('useDark')}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations('shell.nav');
  const { locale } = useLocaleSwitch();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative z-10 min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-e border-sidebar-border bg-sidebar py-6 lg:flex">
        <Wordmark />
        <div className="flex-1 overflow-y-auto px-3">
          <NavList />
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border/70 bg-background/85 px-4 backdrop-blur md:px-8">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label={t('openNavigation')}
              >
                <Menu />
              </Button>
            </SheetTrigger>
            {/* The drawer opens from the start edge: left in LTR, right in RTL. */}
            <SheetContent
              side={directionOf(locale) === 'rtl' ? 'right' : 'left'}
              className="w-72 bg-sidebar p-6"
            >
              <SheetTitle className="sr-only">{t('navigationTitle')}</SheetTitle>
              <div className="mb-8">
                <Wordmark />
              </div>
              <NavList onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="lg:hidden">
            <Wordmark compact />
          </div>
          <div className="ms-auto flex min-w-0 items-center gap-2">
            <div className="hidden md:block">
              <BusinessSwitcher />
            </div>
            <FeedbackButton />
            <LanguageSwitcher />
            <NotificationsBell />
            <ThemeToggle />
            <AccountControls />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8 md:py-10">
          <AccountBanners />
          <UsageBanner />
          {children}
          <UpgradeDialogHost />
        </main>
      </div>
    </div>
  );
}

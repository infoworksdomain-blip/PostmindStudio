'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import {
  BarChart3,
  Building2,
  CalendarDays,
  Clapperboard,
  Film,
  Library,
  Link2,
  Menu,
  Moon,
  Plus,
  Send,
  ShieldAlert,
  Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useBusiness } from './business-context';
import { NotificationsBell } from './notifications-bell';

// Studio's three surfaces (spec 14: create, review, manage) plus Feature A/D and admin screens.

export const NAV = [
  { href: '/new', label: 'Create', icon: Plus, group: 'make' },
  { href: '/projects', label: 'Projects', icon: Clapperboard, group: 'make' },
  { href: '/library', label: 'Reference library', icon: Library, group: 'make' },
  { href: '/publications', label: 'Publications', icon: Send, group: 'manage' },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays, group: 'manage' },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, group: 'manage' },
  { href: '/business', label: 'Business & images', icon: Building2, group: 'setup' },
  { href: '/connections', label: 'Connections', icon: Link2, group: 'setup' },
  { href: '/admin', label: 'Admin', icon: ShieldAlert, group: 'staff' },
] as const;

const GROUP_LABEL: Record<string, string> = {
  make: 'Make',
  manage: 'Manage',
  setup: 'Set up',
  staff: 'PostMind staff',
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? '';
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav aria-label="Studio" className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group}>
          <p className="mb-2 px-3 text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            {GROUP_LABEL[group]}
          </p>
          <ul className="flex flex-col gap-0.5">
            {NAV.filter((n) => n.group === group).map(({ href, label, icon: Icon }) => {
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
                    {label}
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

function Wordmark() {
  return (
    <Link href="/projects" className="flex items-center gap-2 px-3">
      <span className="grid size-7 place-items-center rounded-md bg-foreground text-background">
        <Film className="size-4" strokeWidth={2} />
      </span>
      <span className="font-display text-xl leading-none">
        PostMind <em className="text-primary not-italic">Studio</em>
      </span>
    </Link>
  );
}

export function BusinessSwitcher() {
  const { businessId, setBusinessId, ready } = useBusiness();
  const [draft, setDraft] = useState('');
  if (!ready) return null;
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusinessId(draft || businessId);
        setDraft('');
      }}
    >
      <label htmlFor="business-id" className="text-xs whitespace-nowrap text-muted-foreground">
        Business
      </label>
      <Input
        id="business-id"
        className="h-8 w-44"
        placeholder={businessId ?? 'PostMind business id'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={!draft}>
        Switch
      </Button>
    </form>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? 'Use light theme' : 'Use dark theme'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative z-10 min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-r border-sidebar-border bg-sidebar py-6 lg:flex">
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
                aria-label="Open navigation"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 bg-sidebar p-6">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="mb-8">
                <Wordmark />
              </div>
              <NavList onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="lg:hidden">
            <Wordmark />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden md:block">
              <BusinessSwitcher />
            </div>
            <NotificationsBell />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8 md:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Film, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { directionOf } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { useLocaleSwitch } from '../i18n/intl-provider';
import { WelcomeLink } from '../onboarding/welcome-link';
import { isNavActive, navSections, type NavItem } from './nav';
import { useShowStaff } from './use-show-staff';

// BACKLOG 25.4 — the quiet sidebar: a primary Create button, small group labels, 32px rows, the
// active row on the active surface (no heavy fill, no accent), 16px muted icons. On desktop it
// folds into an icon rail; the choice is remembered per browser (localStorage, best effort).

export const SIDEBAR_STORAGE_KEY = 'studio.sidebar.collapsed';

/** The rail state: expanded until the stored choice is read after hydration (no mismatch). */
export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1');
    } catch {
      // Storage blocked (private window, sandboxed frame): the sidebar stays expanded.
    }
  }, []);
  const update = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; it still applies for this visit.
    }
  }, []);
  return [collapsed, update];
}

/** compact: the mark only (the name stays for screen readers). */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/home"
      className="flex min-w-0 items-center gap-2 rounded-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-control bg-foreground text-background">
        <Film aria-hidden className="size-4" strokeWidth={2} />
      </span>
      <span
        className={cn(
          'text-[0.95rem] leading-none font-semibold tracking-tight whitespace-nowrap',
          compact && 'sr-only',
        )}
      >
        PostMind <span className="text-muted-foreground">Studio</span>
      </span>
    </Link>
  );
}

function NavRow({
  item,
  active,
  collapsed,
  side,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  side: 'left' | 'right';
  onNavigate?: () => void;
}) {
  const t = useTranslations('shell.nav.items');
  const Icon = item.icon;
  const label = t(item.key);
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-8 items-center gap-2.5 rounded-control px-2.5 text-sm',
        'transition-colors duration-(--duration-fast) ease-standard',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active
          ? 'bg-surface-active font-medium text-foreground'
          : 'text-foreground-secondary hover:bg-surface-raised hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
        )}
        strokeWidth={1.75}
      />
      <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The primary action: Create, or "Get started" while onboarding is unfinished. */
function PrimaryAction({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const t = useTranslations('shell.nav');
  const create = (
    <Button
      asChild
      size={collapsed ? 'icon' : 'default'}
      className={cn('w-full', collapsed && 'size-9')}
    >
      {/* Visible "Create"; the name says what it makes (and differs from the nav row). */}
      <Link href="/new" onClick={onNavigate} aria-label={t('newPost')}>
        <Plus aria-hidden />
        {!collapsed && t('items.create')}
      </Link>
    </Button>
  );
  return <WelcomeLink onNavigate={onNavigate} collapsed={collapsed} fallback={create} />;
}

export function NavList({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const t = useTranslations('shell.nav');
  const pathname = usePathname() ?? '';
  const { locale } = useLocaleSwitch();
  const showStaff = useShowStaff();
  // Tooltips sit on the content side of the rail: right in LTR, left in RTL.
  const side = directionOf(locale) === 'rtl' ? 'left' : 'right';
  return (
    <nav aria-label={t('ariaLabel')} className="flex flex-col gap-5">
      <PrimaryAction collapsed={collapsed} onNavigate={onNavigate} />
      <TooltipProvider delayDuration={200}>
        {navSections(showStaff).map(({ group, items }) => (
          <div key={group} className="flex flex-col gap-0.5">
            {group !== 'home' &&
              (collapsed ? (
                <span aria-hidden className="mx-2 mb-1 h-px bg-border" />
              ) : (
                <p className="mb-1 px-2.5 text-[0.6875rem] font-medium text-muted-foreground">
                  {t(`groups.${group}`)}
                </p>
              ))}
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => (
                <li key={item.href}>
                  <NavRow
                    item={item}
                    active={isNavActive(pathname, item.href)}
                    collapsed={collapsed}
                    side={side}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </TooltipProvider>
    </nav>
  );
}

/** The desktop sidebar (lg and up); the drawer below lg reuses NavList. */
export function Sidebar({
  collapsed,
  onCollapsedChange,
}: {
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
}) {
  const t = useTranslations('shell.nav');
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <aside
      data-collapsed={collapsed || undefined}
      className="sticky top-0 hidden h-dvh flex-col border-e border-sidebar-border bg-sidebar lg:flex"
    >
      <div className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center' : 'px-4')}>
        <Wordmark compact={collapsed} />
      </div>
      <div className={cn('flex-1 overflow-y-auto pt-2 pb-4', collapsed ? 'px-2' : 'px-3')}>
        <NavList collapsed={collapsed} />
      </div>
      <div
        className={cn(
          'flex shrink-0 border-t border-sidebar-border py-2',
          collapsed ? 'justify-center' : 'px-3',
        )}
      >
        <Button
          variant="ghost"
          size={collapsed ? 'icon-sm' : 'sm'}
          aria-label={collapsed ? t('expand') : undefined}
          onClick={() => onCollapsedChange(!collapsed)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ToggleIcon aria-hidden className="rtl:-scale-x-100" />
          {!collapsed && t('collapse')}
        </Button>
      </div>
    </aside>
  );
}

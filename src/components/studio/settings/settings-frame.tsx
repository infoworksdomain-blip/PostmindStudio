'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  activeSettingsKey,
  SETTINGS_ITEMS,
  settingsSections,
  type SettingsItem,
  type SettingsKey,
} from './settings-map';

// BACKLOG 25.12 — the Settings area's frame: one sub-navigation beside the page (desktop) or a
// scrolling segmented strip above it (phones and tablets). The current page is marked with
// aria-current; Appearance is a section of Profile, so its anchor lights it while you are there.

/** The in-page anchor of the current URL ("appearance"), also inside the demo's hash routes. */
function currentAnchor(): string {
  if (typeof window === 'undefined') return '';
  const parts = window.location.hash.split('#').filter(Boolean);
  const last = parts.at(-1) ?? '';
  return last.startsWith('/') ? '' : last;
}

function useAnchor(): [string, (next: string) => void] {
  const [anchor, setAnchor] = useState('');
  useEffect(() => {
    const read = () => setAnchor(currentAnchor());
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return [anchor, setAnchor];
}

function anchorOf(item: SettingsItem): string {
  return item.href.split('#')[1] ?? '';
}

function SideLink({
  item,
  active,
  onPick,
}: {
  item: SettingsItem;
  active: boolean;
  onPick: () => void;
}) {
  const t = useTranslations('settingsNav');
  return (
    <Link
      href={item.href}
      onClick={onPick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center justify-between gap-2 rounded-control px-2.5 text-sm',
        'transition-colors duration-(--duration-fast) ease-standard',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active
          ? 'bg-surface-active font-medium text-foreground'
          : 'text-foreground-secondary hover:bg-surface-raised hover:text-foreground',
      )}
    >
      <span className="truncate">{t(`items.${item.key}`)}</span>
      {item.leaves && (
        <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </Link>
  );
}

/** Desktop: grouped list in a sticky column. */
function SideNav({ active, onPick }: { active: SettingsKey | null; onPick: (a: string) => void }) {
  const t = useTranslations('settingsNav');
  return (
    <nav aria-label={t('aria')} className="sticky top-20 hidden lg:block">
      <p className="mb-4 px-2.5 text-xs font-medium text-muted-foreground">{t('title')}</p>
      <div className="flex flex-col gap-5">
        {settingsSections().map(({ group, items }) => (
          <div key={group}>
            <p
              id={`settings-group-${group}`}
              className="mb-1 px-2.5 text-[0.6875rem] font-medium text-muted-foreground"
            >
              {t(`groups.${group}`)}
            </p>
            <ul aria-labelledby={`settings-group-${group}`} className="flex flex-col gap-0.5">
              {items.map((item) => (
                <li key={item.key}>
                  <SideLink
                    item={item}
                    active={item.key === active}
                    onPick={() => onPick(anchorOf(item))}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/** Phones and tablets: every page in one scrolling segmented strip, the current one in view. */
function StripNav({ active, onPick }: { active: SettingsKey | null; onPick: (a: string) => void }) {
  const t = useTranslations('settingsNav');
  const current = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [active]);
  return (
    <nav aria-label={t('aria')} className="-mx-4 mb-6 overflow-x-auto px-4 lg:hidden">
      <ul className="inline-flex min-w-max items-center gap-0.5 rounded-field bg-surface-raised p-0.5">
        {SETTINGS_ITEMS.map((item) => {
          const on = item.key === active;
          return (
            <li key={item.key}>
              <Link
                ref={on ? current : undefined}
                href={item.href}
                onClick={() => onPick(anchorOf(item))}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-control px-3 text-sm font-medium whitespace-nowrap',
                  'transition-[color,background-color,box-shadow] duration-(--duration-fast) ease-standard',
                  'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on
                    ? 'bg-background text-foreground shadow-raised dark:bg-surface-active'
                    : 'text-foreground-secondary hover:text-foreground',
                )}
              >
                {t(`items.${item.key}`)}
                {item.leaves && <ArrowUpRight aria-hidden className="size-3.5" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const [anchor, setAnchor] = useAnchor();
  const active = activeSettingsKey(pathname, anchor);
  return (
    <div
      data-slot="settings-frame"
      className="grid grid-cols-[minmax(0,1fr)] gap-x-12 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start"
    >
      <SideNav active={active} onPick={setAnchor} />
      <div className="min-w-0">
        <StripNav active={active} onPick={setAnchor} />
        {children}
      </div>
    </div>
  );
}

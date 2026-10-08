'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { NativeSelect } from '@/components/ui/native-select';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import {
  ADMIN_GROUPS,
  ADMIN_SECTIONS,
  SECTION_KEY,
  type AdminSection,
  type BillingView,
} from './admin-sections';

// BACKLOG 25.13 — the Admin Centre's sectioned side menu (Operations, Content, Customers,
// Platform) on wide screens, and a native "Go to section" picker on phones and tablets, where a
// side column would squeeze the dense tables. Both drive the same URL-synced section. Items are
// real links (a staff member can open a section in a new tab); a plain click switches in place.
// The kill switch item carries a "Halted" pill while the global switch is engaged.

export interface AdminMenuProps {
  current: AdminSection;
  hrefFor: (section: AdminSection, view?: BillingView) => string;
  onOpen: (section: AdminSection) => void;
  /** The global kill switch is engaged. */
  halted: boolean;
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function AdminMenu({ current, hrefFor, onOpen, halted }: AdminMenuProps) {
  const t = useTranslations('admin.centre');
  const label = (section: AdminSection) => t(`tabs.${SECTION_KEY[section]}`);

  return (
    <>
      <div className="lg:hidden">
        <label
          htmlFor="admin-jump"
          className="mb-1.5 block text-xs font-medium text-muted-foreground"
        >
          {t('menu.jump')}
        </label>
        <NativeSelect
          id="admin-jump"
          value={current}
          onChange={(e) => {
            const next = ADMIN_SECTIONS.find((s) => s === e.target.value);
            if (next) onOpen(next);
          }}
        >
          {ADMIN_GROUPS.map((group) => (
            <optgroup key={group.id} label={t(`menu.groups.${group.id}`)}>
              {group.sections.map((section) => (
                <option key={section} value={section}>
                  {label(section)}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </div>

      <nav aria-label={t('menu.label')} className="hidden lg:block">
        <div className="sticky top-6 grid gap-6">
          {ADMIN_GROUPS.map((group) => (
            <div key={group.id} className="grid gap-1">
              <p
                id={`admin-menu-${group.id}`}
                className="px-2.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t(`menu.groups.${group.id}`)}
              </p>
              <ul aria-labelledby={`admin-menu-${group.id}`} className="grid gap-px">
                {group.sections.map((section) => {
                  const active = section === current;
                  const killSwitch = section === 'kill-switch';
                  return (
                    <li key={section}>
                      <Link
                        href={hrefFor(section)}
                        replace
                        scroll={false}
                        prefetch={false}
                        aria-current={active ? 'page' : undefined}
                        onClick={(event) => {
                          if (!isPlainClick(event)) return;
                          event.preventDefault();
                          onOpen(section);
                        }}
                        className={cn(
                          'flex min-h-8 items-center justify-between gap-2 rounded-control px-2.5 py-1.5 text-sm',
                          'transition-colors duration-(--duration-fast) ease-standard outline-none',
                          'focus-visible:ring-2 focus-visible:ring-ring',
                          active
                            ? 'bg-surface-raised font-medium text-foreground'
                            : 'text-foreground-secondary hover:bg-surface-raised/60 hover:text-foreground',
                          killSwitch &&
                            'text-destructive-foreground hover:text-destructive-foreground',
                        )}
                      >
                        <span className="min-w-0 truncate">{label(section)}</span>
                        {killSwitch && halted && (
                          <StatusPill tone="bad" size="sm" dot>
                            {t('menu.halted')}
                          </StatusPill>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}

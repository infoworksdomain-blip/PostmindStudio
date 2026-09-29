'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// Phase 18 §3 — the /settings/* tabs: Organisation, Members, Billing (Track C's page) and Audit
// log. Links (not a tab widget) so each settings page has its own URL.

const TABS = [
  { href: '/settings/organisation', key: 'organisation' },
  { href: '/settings/members', key: 'members' },
  { href: '/settings/billing', key: 'billing' },
  { href: '/settings/audit', key: 'audit' },
] as const;

export function SettingsNav() {
  const t = useTranslations('orgSettings.nav');
  const pathname = usePathname() ?? '';
  return (
    <nav aria-label={t('aria')} className="mb-8 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {TABS.map(({ href, key }) => {
          const active = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex border-b-2 px-3 py-2 text-sm transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

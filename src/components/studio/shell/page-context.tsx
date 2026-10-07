'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { breadcrumbFor } from './nav';

// BACKLOG 25.4 — the top bar's page context and the content's route-change transition.

/** A two-step trail on nested pages (Projects › Project); nothing on top-level pages. */
export function PageContext() {
  const t = useTranslations('shell.crumbs');
  const tn = useTranslations('shell.nav.items');
  const pathname = usePathname() ?? '';
  const crumb = breadcrumbFor(pathname);
  if (!crumb) return null;
  return (
    <nav aria-label={t('ariaLabel')} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        <li className="shrink-0">
          <Link
            href={crumb.parent.href}
            className="rounded-control text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {tn(crumb.parent.key)}
          </Link>
        </li>
        <li aria-hidden className="shrink-0 text-muted-foreground">
          <ChevronRight className="size-3.5 rtl:-scale-x-100" />
        </li>
        <li aria-current="page" className="min-w-0 truncate font-medium">
          {t(crumb.current)}
        </li>
      </ol>
    </nav>
  );
}

/** Content duration of the route-change fade (≤ 200 ms; nothing under reduced motion). */
export const PAGE_TRANSITION_MS = 180;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * A subtle fade-and-rise when the path changes. It animates opacity and transform only (no layout
 * shift), with the Web Animations API so nothing remounts: a page's state survives, and a change
 * of query string (filters, tabs) does not animate.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return;
    el.animate(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: PAGE_TRANSITION_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
  }, [pathname]);
  return (
    <div ref={ref} data-slot="page-transition">
      {children}
    </div>
  );
}

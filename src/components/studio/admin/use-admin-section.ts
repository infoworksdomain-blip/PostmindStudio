'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  DEFAULT_BILLING_VIEW,
  resolveSection,
  sectionQuery,
  type AdminSection,
  type BillingView,
  type ResolvedSection,
} from './admin-sections';

// BACKLOG 25.13 — the Admin Centre's open section lives in the URL (?tab=, plus ?view= inside
// "Subscriptions & billing"). It is read on every render, not only on load (the 25.1 audit found
// ?tab was read once, so a link to another section from inside the page did nothing), and a change
// replaces the history entry (window.history.replaceState, no RSC refetch): Back leaves the Admin Centre instead of stepping through sections.
// The choice shows at once, before the router has applied the new URL.

export interface AdminSectionState extends ResolvedSection {
  /** The URL (path and query) that opens a section, for links and middle-click. */
  hrefFor: (section: AdminSection, view?: BillingView) => string;
  open: (section: AdminSection, view?: BillingView) => void;
}

export function useAdminSection(): AdminSectionState {
  const pathname = usePathname() ?? '/admin';
  const params = useSearchParams();
  const search = params?.toString() ?? '';
  const fromUrl = resolveSection(params?.get('tab'), params?.get('view'));
  // The last choice, remembered against the query it replaced: once the URL moves on (the router
  // applied it, or a link opened another section) the URL wins again.
  const [chosen, setChosen] = useState<{ value: ResolvedSection; over: string } | null>(null);
  const current = chosen && chosen.over === search ? chosen.value : fromUrl;

  const hrefFor = (section: AdminSection, view?: BillingView) =>
    `${pathname}${sectionQuery(search, section, view)}`;

  const open = (section: AdminSection, view?: BillingView) => {
    const next: ResolvedSection = {
      section,
      view: view ?? (section === current.section ? current.view : DEFAULT_BILLING_VIEW),
    };
    setChosen({ value: next, over: search });
    // The native history API (synced with useSearchParams since Next 14.1): no server round trip,
    // so the page and its <title> stay as they are while the section changes.
    window.history.replaceState(window.history.state, '', hrefFor(next.section, next.view));
  };

  return { ...current, hrefFor, open };
}

'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// BACKLOG 25.8 — the review screen's active tab lives in the URL (?tab=publish), so a link can
// open a tab and a reload keeps it. Switching replaces the history entry (Back leaves the page
// rather than stepping through tabs). The first tab is the default and keeps the URL clean. The
// choice shows at once, before the router has applied the new URL.

export const TAB_PARAM = 'tab';

/** The tab to show: the requested one when it exists for this project, else the first. */
export function resolveTab(requested: string | null | undefined, keys: readonly string[]): string {
  return requested && keys.includes(requested) ? requested : (keys[0] ?? '');
}

/** The query string with `tab` set (or removed for the default tab), as `?…` or ''. */
export function withTab(search: string, tab: string, defaultTab: string): string {
  const params = new URLSearchParams(search);
  if (tab === defaultTab) params.delete(TAB_PARAM);
  else params.set(TAB_PARAM, tab);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useTabParam(): {
  requested: string | null;
  setTab: (tab: string, defaultTab: string) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params?.get(TAB_PARAM) ?? null;
  // The last choice, remembered against the URL value it replaced: once the URL moves on (the
  // router applied it, or a link opened another tab) the URL wins again.
  const [chosen, setChosen] = useState<{ tab: string; over: string | null } | null>(null);
  const requested = chosen && chosen.over === fromUrl ? chosen.tab : fromUrl;

  const setTab = (tab: string, defaultTab: string) => {
    setChosen({ tab, over: fromUrl });
    router.replace(`${pathname}${withTab(params?.toString() ?? '', tab, defaultTab)}`, {
      scroll: false,
    });
  };
  return { requested, setTab };
}

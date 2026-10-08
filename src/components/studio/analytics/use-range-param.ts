'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { RANGE_DAYS, type RangeDays } from './types';

// BACKLOG 25.11 — the analytics period lives in the URL (?days=7|90), so a link opens the same
// window and a reload keeps it. 30 days is the default and keeps the URL clean. Switching replaces
// the history entry, and the choice shows at once, before the router has applied the new URL
// (the same pattern as the review screen's ?tab=, use-tab-param.ts).

export const DAYS_PARAM = 'days';
export const DEFAULT_DAYS: RangeDays = 30;

/** The window to show: a supported ?days value, else the default. */
export function resolveDays(requested: string | null | undefined): RangeDays {
  const n = Number(requested);
  return (RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : DEFAULT_DAYS;
}

/** The query string with `days` set (or removed for the default), as `?…` or ''. */
export function withDays(search: string, days: RangeDays): string {
  const params = new URLSearchParams(search);
  if (days === DEFAULT_DAYS) params.delete(DAYS_PARAM);
  else params.set(DAYS_PARAM, String(days));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useRangeParam(): [RangeDays, (days: RangeDays) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params?.get(DAYS_PARAM) ?? null;
  const [chosen, setChosen] = useState<{ days: RangeDays; over: string | null } | null>(null);
  const days = chosen && chosen.over === fromUrl ? chosen.days : resolveDays(fromUrl);

  const setDays = (next: RangeDays) => {
    setChosen({ days: next, over: fromUrl });
    router.replace(`${pathname}${withDays(params?.toString() ?? '', next)}`, { scroll: false });
  };
  return [days, setDays];
}

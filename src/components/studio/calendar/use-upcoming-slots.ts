'use client';

import { useApi } from '@/lib/client/api';

// 20.3 — GET /businesses/:id/drip-queue/upcoming?from&to: the drip queue's open slots and the
// scheduled-post count for a window (at most 62 days), for the calendar's open-slot markers and
// its "Next 30 days" summary.

export interface UpcomingSlots {
  from: string;
  to: string;
  /** The business has a drip queue (on or off). */
  configured: boolean;
  enabled: boolean;
  slotsPerWeek: number;
  /** How far ahead a video can be given a slot (services/drip-queue.ts DRIP_HORIZON_DAYS). */
  horizonDays: number;
  /** Scheduled / publishing posts of the business in the window. */
  scheduled: number;
  openSlots: string[];
  held: Array<{ slotAt: string; projectId: string }>;
  /** 20.9: month-plan posts not yet scheduled (absent from older servers / the demo). */
  planned?: PlannedPost[];
}

/** 20.9: a month-plan post still being made (GET …/drip-queue/upcoming `planned`). */
export interface PlannedPost {
  slotAt: string;
  planId: string;
  itemId: string;
  title: string;
  kind: 'VIDEO' | 'SLIDESHOW';
  status: 'QUEUED' | 'GENERATING' | 'READY' | 'HELD';
}

export const SUMMARY_DAYS = 30;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function upcomingPath(businessId: string): string {
  return `/businesses/${encodeURIComponent(businessId)}/drip-queue/upcoming`;
}

/** The summary window: now (to the minute, so the request key is stable) → +30 days. */
export function summaryWindow(now: number): { from: string; to: string } {
  const from = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return {
    from: new Date(from).toISOString(),
    to: new Date(from + SUMMARY_DAYS * DAY_MS).toISOString(),
  };
}

/** Skip the request (null) without a business or when the window is entirely in the past. */
export function useUpcomingSlots(
  businessId: string | null,
  window: { from: string; to: string },
  now: number,
) {
  const past = Date.parse(window.to) <= now;
  return useApi<{ upcoming: UpcomingSlots }>(
    businessId && !past ? upcomingPath(businessId) : null,
    { from: window.from, to: window.to },
  );
}

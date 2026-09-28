import type { Tone } from '@/lib/client/format';
import type { LibraryVideoSummary } from '../library/types';
import type { LicenseScenario } from './types';

// 15.D7 — response shapes of the staff library endpoints (services/library-admin.ts).

export type LicenceStatus = 'missing' | 'expired' | 'expiring' | 'ok';
export type CategoryReview = 'ACCEPTED' | 'OVERRIDDEN' | 'REJECTED';
export type BulkAction = 'accept' | 'override' | 'reject';

/** GET /admin/library/videos row: the user summary plus staff-only state. */
export interface AdminLibraryVideo extends LibraryVideoSummary {
  ingestedAt: string;
  retiredAt: string | null;
  reanalysedAt: string | null;
  categoryReview: CategoryReview | null;
  categoryReviewedAt: string | null;
  licence: {
    status: LicenceStatus;
    scenario: LicenseScenario | null;
    licenseExpires: string | null;
    licenseSource: string | null;
  };
}

export interface AdminLibraryFilters {
  licence: string;
  retired: string;
  review: string;
  category: string;
  q: string;
}

export const DEFAULT_FILTERS: AdminLibraryFilters = {
  licence: '',
  retired: 'false',
  review: '',
  category: '',
  q: '',
};

export interface BulkResponse {
  action: BulkAction;
  updated: string[];
  missing: string[];
  retired: number;
  categoryId: string | null;
}

export interface ReanalyseResponse {
  queued: Array<{ id: string; jobId: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

export interface LicenceAuditResponse {
  generatedAt: string;
  expiringWithinDays: number;
  live: number;
  retired: number;
  byScenario: Record<LicenseScenario, number>;
  missing: number;
  expired: number;
  expiringSoon: number;
  problems: Array<{
    id: string;
    title: string;
    problem: LicenceStatus;
    licenseExpires: string | null;
  }>;
  problemsTruncated: boolean;
}

/** Badge tone per licence status; the label is admin.library.licenceBadge.<status>. */
export const LICENCE_TONE: Record<LicenceStatus, Tone> = {
  missing: 'bad',
  expired: 'bad',
  expiring: 'warn',
  ok: 'good',
};

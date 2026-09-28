'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CircleAlert } from 'lucide-react';
import { useApi } from '@/lib/client/api';
import type { BusinessProfile } from './types';

// 15.D8 / A13 — "low-confidence classifications flagged for user review before use". Where
// generation uses the business profile (Create), a flagged profile is surfaced, not blocked:
// the video is still made from it, and the user is pointed at the Business screen to confirm.
// No profile yet (404) or any error → nothing is shown.

export function ProfileReviewNotice({ businessId }: { businessId: string | null }) {
  const t = useTranslations('business');
  const { data } = useApi<{ profile: BusinessProfile }>(
    businessId ? `/businesses/${encodeURIComponent(businessId)}/business-profile` : null,
    undefined,
    { shouldRetryOnError: false },
  );
  if (!data?.profile.needsReview) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {t.rich('reviewNotice', {
          link: (chunks) => (
            <Link href="/business" className="font-medium underline">
              {chunks}
            </Link>
          ),
        })}
      </span>
    </p>
  );
}

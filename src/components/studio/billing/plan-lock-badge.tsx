'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import {
  minTierFor,
  minTierForImageLibrary,
  tierAtLeast,
  type PlanFeatureFlag,
} from '@/lib/studio/billing/catalogue';
import { cn } from '@/lib/utils';
import type { UsageResponse } from '../usage-meter';
import { isPlanTier, type PlanTier } from './types';

// Phase 18 §P.4 — inline lock badges on gated controls (voice clone, 4K, TEMPLATE mode, image
// generation, BYOC keys, custom presets). The minimum tier comes from the plan catalogue (the same
// data the server gates read); the current tier from GET /usage (shared SWR cache with the usage
// banner). The badge is informational: the server still enforces the gate, and a blocked call
// opens the upgrade dialog. Nothing renders while the tier is unknown or already high enough.

export type LockFeature = Exclude<PlanFeatureFlag, 'selfServe'> | 'imageGeneration';

export function minTierForFeature(feature: LockFeature): PlanTier {
  return feature === 'imageGeneration'
    ? minTierForImageLibrary('ai_generation')
    : minTierFor(feature);
}

/** The organisation's plan tier from GET /usage; undefined while loading or on error. */
export function usePlanTier(): PlanTier | undefined {
  // Read after mount so the gated screen’s own requests go first (the badge is decoration).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const res = useApi<UsageResponse>(mounted ? '/usage' : null);
  // Defensive: a mocked or partial /usage body must never break the gated screen around the badge.
  const tier: unknown = res.data?.usage?.planTier;
  return isPlanTier(tier) ? tier : undefined;
}

export function PlanLockBadge({
  requiredTier,
  feature,
  className,
}: {
  requiredTier?: PlanTier;
  feature?: LockFeature;
  className?: string;
}) {
  const t = useTranslations('upgrade.lock');
  const tTier = useTranslations('shell.usage.tiers');
  const current = usePlanTier();
  const required = requiredTier ?? (feature ? minTierForFeature(feature) : undefined);
  if (!required || !current || tierAtLeast(current, required)) return null;
  const tier = tTier(required);
  return (
    <span
      data-slot="plan-lock-badge"
      title={t('aria', { tier })}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 align-middle text-[0.7rem] font-medium text-primary',
        className,
      )}
    >
      <Lock className="size-3" strokeWidth={2} aria-hidden />
      <span aria-hidden>{tier}</span>
      <span className="sr-only">{t('aria', { tier })}</span>
    </span>
  );
}

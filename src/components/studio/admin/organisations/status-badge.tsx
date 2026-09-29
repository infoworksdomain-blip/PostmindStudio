'use client';

import { useTranslations } from 'next-intl';
import type { Tone } from '@/lib/client/format';
import { StateBadge } from '../../primitives';

// Phase 18 admin — one badge for Stripe subscription statuses, billing access and deletion, in
// the reader's language. An unknown value (a future Stripe status) shows as-is, neutral.

const STATUS = {
  trialing: { key: 'trialing', tone: 'live' },
  active: { key: 'active', tone: 'good' },
  past_due: { key: 'pastDue', tone: 'warn' },
  unpaid: { key: 'unpaid', tone: 'bad' },
  canceled: { key: 'canceled', tone: 'neutral' },
  incomplete: { key: 'incomplete', tone: 'warn' },
  incomplete_expired: { key: 'incompleteExpired', tone: 'neutral' },
  paused: { key: 'paused', tone: 'neutral' },
  full: { key: 'full', tone: 'good' },
  read_only: { key: 'readOnly', tone: 'bad' },
  none: { key: 'noPlan', tone: 'neutral' },
  deleted: { key: 'deleted', tone: 'bad' },
  banned: { key: 'banned', tone: 'bad' },
} as const satisfies Record<string, { key: string; tone: Tone }>;

type Known = keyof typeof STATUS;

export function StatusBadge({ value }: { value: string }) {
  const t = useTranslations('adminOrgs.status');
  if (!(value in STATUS)) return <StateBadge label={value} tone="neutral" />;
  const { key, tone } = STATUS[value as Known];
  return <StateBadge label={t(key)} tone={tone} />;
}

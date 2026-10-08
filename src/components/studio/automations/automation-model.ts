// 22.5 — the Automations screens' data (services/automations.ts automationSummary and
// services/automation-actions.ts automationDetail).

export type AutomationStatus =
  'DRAFT' | 'GENERATING' | 'REVIEW' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export type Cadence =
  { mode: 'per_day'; postsPerDay: number } | { mode: 'per_week'; postsPerWeek: number };

export const DURATIONS = ['one_week', 'four_weeks', 'ongoing_weekly', 'ongoing_monthly'] as const;
export type Duration = (typeof DURATIONS)[number];

export interface AutomationSummary {
  id: string;
  businessId: string;
  name: string;
  status: AutomationStatus;
  cadence: Cadence;
  duration: Duration;
  ongoing: boolean;
  platforms: string[];
  targets: Array<{ platform: string; connectionId: string | null }>;
  approvalMode: 'review' | 'auto';
  periodIndex: number;
  currentPlanId: string | null;
  pauseReason: string | null;
  activatedAt: string | null;
  createdAt: string;
  /** 25.9: when its next post goes out (list endpoint; absent / null when none is due). */
  nextPostAt?: string | null;
}

export interface AutomationSlot {
  id: string;
  slotAt: string;
  kind: string;
  format: string | null;
  angle: string;
  angleId: string | null;
  title: string;
  slides: { hook: string; points: string[]; cta: string } | null;
  status: string;
  statusReason: string | null;
  projectId: string | null;
  reviewed: boolean;
  downloadOnly: string[];
  /** 23.6: when Studio starts creating this queued post (null once due or started). */
  createsAt?: string | null;
}

export interface AutomationPeriod {
  id: string;
  status: string;
  startDate: string;
  days: number;
  timezone: string;
  holdReason: string | null;
  cappedReason: string | null;
  items: AutomationSlot[];
}

export interface AutomationInsight {
  at: string;
  itemId: string;
  title: string;
  format: string | null;
  views: number;
}

export interface AutomationDetail {
  automation: AutomationSummary & { insight: AutomationInsight | null };
  periods: AutomationPeriod[];
}

export interface AutomationEstimate {
  posts: number;
  periodDays: number;
  ongoing: boolean;
  split: Record<string, number>;
  paidPosts: number;
  allowanceUnits: number;
  /** Staff only. */
  estimatePence?: number;
}

export function statusTone(status: AutomationStatus): 'neutral' | 'live' | 'good' | 'warn' | 'bad' {
  switch (status) {
    case 'ACTIVE':
      return 'good';
    case 'GENERATING':
      return 'live';
    case 'REVIEW':
    case 'PAUSED':
      return 'warn';
    case 'CANCELLED':
      return 'bad';
    default:
      return 'neutral';
  }
}

export const PAUSE_REASONS = [
  'owner',
  'allowance',
  'billing',
  'owner_left',
  'plan_missing',
  'no_free_slots',
  'no_formats',
  'cost_cap',
  'draft_failed',
] as const;

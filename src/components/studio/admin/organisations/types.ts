// Phase 18 §3 / 20.27 / 21.5 — the shapes the admin organisation endpoints answer with (split out
// of organisations-tab.tsx in 25.13).

export type TrialState = 'running' | 'overridden' | 'ended';

export interface AdminOrgTrial {
  state: TrialState;
  endsAt: string | null;
}

/** 21.5: the per-channel plan in force (staff override or Stripe), null when there is none. */
export interface AdminOrgChannelPlan {
  channels: number;
  interval: 'week' | 'month' | 'year';
  source: 'stripe' | 'admin';
}

export interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  createdAt: string;
  deletedAt: string | null;
  members: number;
  tier: string | null;
  access: string | null;
  source: string | null;
  trial: AdminOrgTrial | null;
  /** Optional: absent from responses written before 21.5. */
  channelPlan?: AdminOrgChannelPlan | null;
  subscriptionStatus: string | null;
  costThisMonthPence: number;
}

export interface AdminOrgsResponse {
  ok: true;
  total: number;
  offset: number;
  pageSize: number;
  data: AdminOrgRow[];
}

export interface AdminSubscription {
  id: string;
  organisationId: string;
  status: string;
  lookupKey: string | null;
  interval: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  updatedAt: string;
}

export interface AdminOrgDetail {
  ok: true;
  organisation: {
    id: string;
    name: string;
    slug: string;
    country: string | null;
    defaultLocale: string | null;
    createdAt: string;
    deletedAt: string | null;
  };
  members: Array<{
    id: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    twoFactorEnabled: boolean;
    joinedAt: string;
  }>;
  pendingInvitations: number;
  businesses: number;
  entitlement: {
    tier: string;
    access: string;
    source: string;
    trial: AdminOrgTrial | null;
    channelPlan?: AdminOrgChannelPlan | null;
    graceUntil: string | null;
    trialStartedAt: string | null;
    everPaidAt: string | null;
    reason: string | null;
    updatedAt: string;
  } | null;
  subscriptions: AdminSubscription[];
  costThisMonthPence: number;
}

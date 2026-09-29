'use client';

import { EntitlementsPanel } from './entitlements-panel';
import { SubscriptionsPanel } from './subscriptions-panel';

// Phase 18 §3 / §P.4 — the admin centre's Billing tab: per-organisation entitlement overrides and
// the subscriptions list with MRR.
export function AdminBillingTab() {
  return (
    <div className="grid gap-10">
      <EntitlementsPanel />
      <SubscriptionsPanel />
    </div>
  );
}

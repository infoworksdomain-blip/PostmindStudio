import type { ReactNode } from 'react';
import { MarketingShell } from '@/components/marketing/marketing-shell';

// Phase 18 §3 — the public pages (landing, pricing, legal): marketing header and footer, no app
// shell. Track C's /pricing page lives in this group too.
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <MarketingShell entityName={process.env.STUDIO_LEGAL_ENTITY_NAME}>{children}</MarketingShell>
  );
}

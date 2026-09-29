'use client';

import { FileWarning } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { legalDocKey } from '@/components/marketing/legal-doc-keys';

// Phase 18 legal-readiness gate, admin side: while any legal document is still the repository
// placeholder (or missing), staff see which ones and whether public sign-up is held closed.
// A failed read renders nothing: the gate itself is enforced on the server.

interface LegalReadinessResponse {
  ok: true;
  readiness: {
    docs: Array<{ doc: string; present: boolean; placeholder: boolean }>;
    ready: boolean;
    launchBlockers: string[];
  };
  signups: { open: boolean; reason?: 'disabled' | 'legal_placeholder' };
}

export function LegalReadinessWarning() {
  const t = useTranslations('adminOrgs.legal');
  const tl = useTranslations('legal.docs');
  const { data } = useApi<LegalReadinessResponse>('/admin/legal-readiness');
  if (!data || data.readiness.ready) return null;
  const outstanding = data.readiness.docs.filter((d) => !d.present || d.placeholder);
  return (
    <div
      role="alert"
      className="mb-6 flex gap-3 rounded-xl border border-warning/50 bg-warning/15 p-4 text-sm"
    >
      <FileWarning aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-1">
        <p className="font-semibold">{t('title')}</p>
        <p className="text-muted-foreground">
          {data.readiness.launchBlockers.length > 0 ? t('blocking') : t('warning')}
        </p>
        <ul className="mt-1 flex flex-wrap gap-2">
          {outstanding.map((d) => {
            const key = legalDocKey(d.doc);
            return (
              <li key={d.doc} className="rounded-full bg-background/70 px-2.5 py-0.5 text-xs">
                {key ? tl(key) : d.doc}
                {' · '}
                {d.present ? t('placeholder') : t('missing')}
              </li>
            );
          })}
        </ul>
        {data.signups.reason === 'legal_placeholder' && (
          <p className="mt-1 font-medium">{t('signupsClosed')}</p>
        )}
      </div>
    </div>
  );
}

// Phase 13 Wave B (track B): endpoints whose real routes answer 501 until PostMind Core ships the
// endpoint they wait for. The demo shows the INTENDED 200 response so the screens can be seen,
// and every body carries `preview: true` — a field that exists only in the demo, never in the
// real API — so nobody mistakes it for a working feature.
//   GET /businesses                        real: 501 waiting for Core list-businesses (13.34)
//   GET /admin/channels/reconciliation     real: 501 waiting for Core list-channels (13.35)
import { CONNECTIONS, DEMO_BUSINESS_ID, DEMO_BUSINESS_NAME, DEMO_ORG_ID } from '../ids';
import { route } from '../registry';

route('GET', '/businesses', () => ({
  preview: true,
  data: [
    { id: DEMO_BUSINESS_ID, name: DEMO_BUSINESS_NAME, domain: 'leedssourdough.co.uk' },
    { id: 'biz-leeds-sourdough-market', name: 'Leeds Sourdough — Kirkgate Market stall' },
  ],
}));

route('GET', '/admin/channels/reconciliation', ({ query }) => {
  const organisationId = query.get('organisationId');
  const organisations =
    organisationId && organisationId !== DEMO_ORG_ID
      ? []
      : [
          {
            organisationId: DEMO_ORG_ID,
            matched: 1,
            findings: [
              {
                kind: 'name_changed',
                channel: {
                  id: CONNECTIONS.instagram.id,
                  platform: 'instagram',
                  platformAccountId: CONNECTIONS.instagram.accountId,
                  platformAccountName: CONNECTIONS.instagram.account,
                  state: 'active',
                },
                coreName: 'leedssourdough.bakery',
                action: 'rename',
              },
              {
                kind: 'missing_in_core',
                channel: {
                  id: CONNECTIONS.facebook.id,
                  platform: 'facebook',
                  platformAccountId: CONNECTIONS.facebook.accountId,
                  platformAccountName: CONNECTIONS.facebook.account,
                  state: 'active',
                },
                action: 'disconnect',
              },
            ],
          },
        ];
  return {
    preview: true,
    report: {
      checkedAt: new Date().toISOString(),
      applied: false,
      organisations,
      errors: [],
      totals: {
        organisations: organisations.length,
        matched: organisations.length ? 1 : 0,
        findings: organisations.length ? 2 : 0,
        disconnected: 0,
      },
    },
  };
});

import { describe, expect, it } from 'vitest';
import { accessDecision } from '@/lib/studio/billing/access-gate';
import { isLocale } from '@/lib/i18n/locales';
import { demoAccessDecision } from '../../demo/api/billing-access';
import { isBillingStateId, parseCheckoutIntent } from '../../demo/api/billing-state';
import { isKnownRoute, splitHref } from '../../demo/routes';
import { FEATURE_SECTIONS, featureLinks } from '../../demo/tour/features-data';
import { SCREEN_GROUPS } from '../../demo/tour/screens-data';
import { WORKFLOWS } from '../../demo/tour/workflows';
import { isPreviewTemplate } from '../../demo/tour/email-preview-data';

// The demo tour's links (guided workflows, the "Everything built" index, the screen index) must
// each open a screen demo/app.tsx renders (demo/routes.ts is the list app.tsx is typed against),
// and any state they carry (?demoPlan=, ?lang=, a checkout or email) must be one the demo knows.

const stepLinks = WORKFLOWS.flatMap((w) => w.steps.map((s) => ({ flow: w.id, href: s.href })));
const screenLinks = SCREEN_GROUPS.flatMap((g) =>
  g.screens.flatMap((s) => [s.href, ...(s.links ?? []).map((l) => l.href)]),
);

function problemsOf(href: string): string[] {
  const problems: string[] = [];
  if (!href.startsWith('#/')) problems.push('not a hash route');
  if (!isKnownRoute(href)) problems.push('no route in demo/app.tsx');
  const { pathname, search } = splitHref(href);
  const plan = search.get('demoPlan');
  if (plan !== null && !isBillingStateId(plan)) problems.push(`unknown demoPlan ${plan}`);
  const lang = search.get('lang');
  if (lang !== null && !isLocale(lang)) problems.push(`unknown lang ${lang}`);
  if (pathname === '/demo-checkout' && !parseCheckoutIntent(search))
    problems.push('checkout link the demo checkout cannot read');
  const email = pathname.match(/^\/tour\/email\/(.+)$/)?.[1];
  if (email && !isPreviewTemplate(email)) problems.push(`no email preview ${email}`);
  return problems;
}

describe('demo tour links', () => {
  it('has the guided workflows, each with 4–8 steps that all link somewhere', () => {
    expect(WORKFLOWS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(WORKFLOWS.map((w) => w.id)).size).toBe(WORKFLOWS.length);
    for (const w of WORKFLOWS) {
      expect(w.steps.length, w.id).toBeGreaterThanOrEqual(4);
      expect(w.steps.length, w.id).toBeLessThanOrEqual(8);
      for (const s of w.steps) {
        expect(s.href, w.id).toBeTruthy();
        expect(s.cta, w.id).toBeTruthy();
      }
    }
  });

  it.each(stepLinks)('workflow $flow step $href opens a known screen and state', ({ href }) => {
    expect(problemsOf(href)).toEqual([]);
  });

  it('lists every feature area with a link per feature', () => {
    expect(FEATURE_SECTIONS.map((s) => s.label)).toEqual([
      'Create',
      'Review',
      'Library',
      'Publishing',
      'Analytics',
      'Business',
      'Connections',
      'Billing & plans',
      'Accounts & teams',
      'Admin',
      'Languages',
      'Reliability & ops',
      'Deployment',
    ]);
    for (const s of FEATURE_SECTIONS) expect(s.features.length, s.id).toBeGreaterThan(0);
  });

  it.each(featureLinks())('feature link %s opens a known screen and state', (href) => {
    expect(problemsOf(href)).toEqual([]);
  });

  it.each(screenLinks)('screen index link %s opens a known screen', (href) => {
    expect(problemsOf(href)).toEqual([]);
  });

  it('flags a link to a screen the demo does not have', () => {
    expect(problemsOf('#/settings/nowhere')).toContain('no route in demo/app.tsx');
    expect(problemsOf('#/projects?demoPlan=gold')).toContain('unknown demoPlan gold');
  });
});

describe('demo access gate', () => {
  const paths = [
    '/projects/p1/generate',
    '/projects',
    '/publications',
    '/publications/x/retry',
    '/voice-profiles',
    '/image-library/generate',
    '/billing/checkout',
    '/billing/portal',
    '/account/export',
    '/account/delete',
    '/members/invitations',
    '/org',
    '/renders/r1/download',
    '/renders/r1/rerender',
    '/businesses/b1/scan-website',
    '/admin/kill-switch',
    '/brand-kits',
  ];
  it.each(['full', 'read_only', 'none'] as const)(
    'matches the real accessDecision for access %s',
    (access) => {
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
        for (const path of paths) {
          expect(demoAccessDecision(access, method, path), `${method} ${path}`).toEqual(
            accessDecision(access, method, `/api/studio${path}`),
          );
        }
      }
    },
  );
});

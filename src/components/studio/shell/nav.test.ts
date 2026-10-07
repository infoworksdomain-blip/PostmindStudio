import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasStudioPage, STUDIO_APP_DIR } from '../../../../test/helpers/studio-pages';
import { breadcrumbFor, isNavActive, NAV, navSections } from './nav';

// BACKLOG 25.4 — the navigation map points only at real pages, keeps every section reachable and
// draws breadcrumbs only for the nested pages.

const STUDIO = STUDIO_APP_DIR;

describe('navigation map', () => {
  it('links only to pages that exist', () => {
    for (const item of NAV) expect(hasStudioPage(item.href), item.href).toBe(true);
  });

  it('groups the app as Home, Create, Plan, Library, Insights, Settings (+ staff)', () => {
    const groups = navSections(true).map((s) => [s.group, s.items.map((i) => i.href)]);
    expect(groups).toEqual([
      ['home', ['/home']],
      ['create', ['/new', '/blitz', '/templates']],
      ['plan', ['/calendar', '/plans', '/automations', '/publications']],
      ['library', ['/projects', '/library', '/business']],
      ['insights', ['/analytics']],
      ['settings', ['/connections', '/approvals', '/settings/organisation']],
      ['staff', ['/admin']],
    ]);
    expect(navSections(false).some((s) => s.group === 'staff')).toBe(false);
  });

  it('keeps every (studio) section reachable (account pages via the account menu, /welcome via Get started)', () => {
    const sections = readdirSync(STUDIO, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `/${e.name}`);
    const fromNav = new Set(NAV.map((n) => `/${n.href.split('/')[1]}`));
    const elsewhere = new Set(['/account', '/welcome']);
    for (const section of sections)
      expect(fromNav.has(section) || elsewhere.has(section), section).toBe(true);
  });

  it('marks the section of nested pages active, and every settings page as Settings', () => {
    expect(isNavActive('/projects/p1', '/projects')).toBe(true);
    expect(isNavActive('/plans/new', '/plans')).toBe(true);
    expect(isNavActive('/settings/billing', '/settings/organisation')).toBe(true);
    expect(isNavActive('/projectsx', '/projects')).toBe(false);
    expect(isNavActive('/home', '/new')).toBe(false);
  });

  it('draws a breadcrumb for nested pages only', () => {
    expect(breadcrumbFor('/projects')).toBeNull();
    expect(breadcrumbFor('/home')).toBeNull();
    const cases: Array<[string, string, string]> = [
      ['/projects/p1', '/projects', 'project'],
      ['/plans/new', '/plans', 'newPlan'],
      ['/plans/pl_1', '/plans', 'plan'],
      ['/automations/new', '/automations', 'newAutomation'],
      ['/automations/a1', '/automations', 'automation'],
      ['/library/lib_1', '/library', 'libraryVideo'],
      ['/analytics/publications/pub_1', '/analytics', 'publicationAnalytics'],
    ];
    for (const [path, parent, current] of cases) {
      expect(breadcrumbFor(path), path).toEqual({
        parent: expect.objectContaining({ href: parent }),
        current,
      });
    }
  });
});

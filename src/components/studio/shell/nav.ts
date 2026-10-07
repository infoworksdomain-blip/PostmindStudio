import {
  BarChart3,
  Building2,
  CalendarDays,
  CalendarRange,
  Clapperboard,
  House,
  Images,
  Layers,
  LayoutTemplate,
  Library,
  Link2,
  ListChecks,
  Plus,
  Repeat,
  Send,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

// BACKLOG 25.4 — the app's navigation map, as data. Labels come from `shell.nav.items.<key>` and
// group headings from `shell.nav.groups.<group>`; the sidebar, the mobile drawer and the command
// menu all read this list, so a destination added here is reachable everywhere. Routes are never
// renamed: every entry points at an existing (studio) page.

export type NavGroup = 'home' | 'create' | 'plan' | 'library' | 'insights' | 'settings' | 'staff';

export interface NavItem {
  href: string;
  key:
    | 'home'
    | 'create'
    | 'blitz'
    | 'images'
    | 'templates'
    | 'calendar'
    | 'plans'
    | 'automations'
    | 'publications'
    | 'projects'
    | 'library'
    | 'business'
    | 'analytics'
    | 'connections'
    | 'approvals'
    | 'settings'
    | 'admin';
  icon: LucideIcon;
  group: NavGroup;
}

export const NAV: readonly NavItem[] = [
  { href: '/home', key: 'home', icon: House, group: 'home' },
  { href: '/new', key: 'create', icon: Plus, group: 'create' },
  // 22.4: swipe through ready-made posts.
  { href: '/blitz', key: 'blitz', icon: Layers, group: 'create' },
  // 25.8: the Image Studio (generate images from a prompt; was a dialog in Business → Images).
  { href: '/images', key: 'images', icon: Images, group: 'create' },
  { href: '/templates', key: 'templates', icon: LayoutTemplate, group: 'create' },
  { href: '/calendar', key: 'calendar', icon: CalendarDays, group: 'plan' },
  // 20.9: Plan my month (it had no way in from the sidebar before 25.4).
  { href: '/plans', key: 'plans', icon: CalendarRange, group: 'plan' },
  // 22.5: weekly / monthly auto generation and posting.
  { href: '/automations', key: 'automations', icon: Repeat, group: 'plan' },
  { href: '/publications', key: 'publications', icon: Send, group: 'plan' },
  { href: '/projects', key: 'projects', icon: Clapperboard, group: 'library' },
  { href: '/library', key: 'library', icon: Library, group: 'library' },
  { href: '/business', key: 'business', icon: Building2, group: 'library' },
  { href: '/analytics', key: 'analytics', icon: BarChart3, group: 'insights' },
  { href: '/connections', key: 'connections', icon: Link2, group: 'settings' },
  { href: '/approvals', key: 'approvals', icon: ListChecks, group: 'settings' },
  // Phase 18: organisation settings, members, billing and audit (active on every /settings/* page).
  { href: '/settings/organisation', key: 'settings', icon: Settings, group: 'settings' },
  { href: '/admin', key: 'admin', icon: ShieldAlert, group: 'staff' },
];

export const NAV_GROUPS: readonly NavGroup[] = [
  'home',
  'create',
  'plan',
  'library',
  'insights',
  'settings',
  'staff',
];

/** The navigation entry a path belongs to (/settings/* and the /account/* pages light up Settings). */
export function isNavActive(pathname: string, href: string): boolean {
  if (href.startsWith('/settings/'))
    return pathname.startsWith('/settings/') || pathname.startsWith('/account/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Items grouped in display order, without the staff group unless `showStaff`. */
export function navSections(showStaff: boolean): Array<{ group: NavGroup; items: NavItem[] }> {
  return NAV_GROUPS.filter((g) => showStaff || g !== 'staff')
    .map((group) => ({ group, items: NAV.filter((n) => n.group === group) }))
    .filter((s) => s.items.length > 0);
}

/** The label key for the current page of a nested route (`shell.crumbs.<key>`). */
export type CrumbKey =
  | 'project'
  | 'plan'
  | 'newPlan'
  | 'automation'
  | 'newAutomation'
  | 'libraryVideo'
  | 'publicationAnalytics';

export interface Breadcrumb {
  parent: NavItem;
  current: CrumbKey;
}

const NESTED: ReadonlyArray<{ pattern: RegExp; parent: NavItem['key']; current: CrumbKey }> = [
  { pattern: /^\/projects\/[^/]+\/?$/, parent: 'projects', current: 'project' },
  { pattern: /^\/plans\/new\/?$/, parent: 'plans', current: 'newPlan' },
  { pattern: /^\/plans\/[^/]+\/?$/, parent: 'plans', current: 'plan' },
  { pattern: /^\/automations\/new\/?$/, parent: 'automations', current: 'newAutomation' },
  { pattern: /^\/automations\/[^/]+\/?$/, parent: 'automations', current: 'automation' },
  { pattern: /^\/library\/[^/]+\/?$/, parent: 'library', current: 'libraryVideo' },
  {
    pattern: /^\/analytics\/publications\/[^/]+\/?$/,
    parent: 'analytics',
    current: 'publicationAnalytics',
  },
];

/** A two-step trail for the nested pages (parent section → this page); null elsewhere. */
export function breadcrumbFor(pathname: string): Breadcrumb | null {
  const match = NESTED.find((n) => n.pattern.test(pathname));
  if (!match) return null;
  const parent = NAV.find((n) => n.key === match.parent);
  return parent ? { parent, current: match.current } : null;
}

// BACKLOG 25.12 — the Settings area as data. One list feeds the settings sub-navigation (a side
// list on desktop, a scrolling segmented strip on phones), the command menu and the check that
// decides which pages are framed as settings. Routes are never renamed: every entry points at an
// existing page, plus /settings/provider-keys and /settings/notifications (25.12).
// Labels are `settingsNav.items.<key>` and group headings `settingsNav.groups.<group>`.

export type SettingsGroup = 'account' | 'workspace' | 'publishing' | 'billing';

export type SettingsKey =
  | 'profile'
  | 'security'
  | 'appearance'
  | 'notifications'
  | 'organisation'
  | 'members'
  | 'audit'
  | 'approvals'
  | 'export'
  | 'business'
  | 'connections'
  | 'providerKeys'
  | 'billing';

export interface SettingsItem {
  key: SettingsKey;
  /** The page (with an in-page anchor for Appearance). */
  href: string;
  group: SettingsGroup;
  /** Opens a page outside the Settings frame (Brand and business has its own workspace). */
  leaves?: boolean;
}

export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { key: 'profile', href: '/account/profile', group: 'account' },
  { key: 'security', href: '/account/security', group: 'account' },
  { key: 'appearance', href: '/account/profile#appearance', group: 'account' },
  { key: 'notifications', href: '/settings/notifications', group: 'account' },
  { key: 'organisation', href: '/settings/organisation', group: 'workspace' },
  { key: 'members', href: '/settings/members', group: 'workspace' },
  { key: 'audit', href: '/settings/audit', group: 'workspace' },
  { key: 'approvals', href: '/approvals', group: 'workspace' },
  { key: 'export', href: '/account/export', group: 'workspace' },
  { key: 'business', href: '/business', group: 'publishing', leaves: true },
  { key: 'connections', href: '/connections', group: 'publishing' },
  { key: 'providerKeys', href: '/settings/provider-keys', group: 'publishing' },
  { key: 'billing', href: '/settings/billing', group: 'billing' },
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  'account',
  'workspace',
  'publishing',
  'billing',
];

/** The items of each group, in display order. */
export function settingsSections(): Array<{ group: SettingsGroup; items: SettingsItem[] }> {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    items: SETTINGS_ITEMS.filter((item) => item.group === group),
  }));
}

function splitHref(href: string): { path: string; anchor: string } {
  const [path = href, anchor = ''] = href.split('#');
  return { path, anchor };
}

/** Pages shown inside the Settings frame (every item except the ones that leave it). */
export function isSettingsPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return SETTINGS_ITEMS.some((item) => !item.leaves && splitHref(item.href).path === path);
}

/**
 * The item for this page. `anchor` is the in-page anchor (without '#'): Appearance is a section
 * of Profile, so /account/profile#appearance lights Appearance and every other anchor Profile.
 */
export function activeSettingsKey(pathname: string, anchor = ''): SettingsKey | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  const onPage = SETTINGS_ITEMS.filter((item) => splitHref(item.href).path === path);
  const exact = onPage.find((item) => anchor && splitHref(item.href).anchor === anchor);
  if (exact) return exact.key;
  return onPage.find((item) => !splitHref(item.href).anchor)?.key ?? null;
}

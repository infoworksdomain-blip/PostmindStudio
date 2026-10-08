import { describe, expect, it } from 'vitest';
import { PROTECTED_PAGE_PREFIXES, isProtectedPage } from '@/lib/auth/page-guard';
import {
  activeSettingsKey,
  isSettingsPath,
  SETTINGS_ITEMS,
  settingsSections,
} from './settings-map';

describe('settings map (25.12)', () => {
  it('groups every settings page once, in order', () => {
    const keys = settingsSections().flatMap((s) => s.items.map((i) => i.key));
    expect(keys).toEqual(SETTINGS_ITEMS.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(settingsSections().map((s) => s.group)).toEqual([
      'account',
      'workspace',
      'publishing',
      'billing',
    ]);
  });

  it('frames the settings pages, not Brand and business', () => {
    for (const path of [
      '/account/profile',
      '/account/security',
      '/account/export',
      '/settings/organisation',
      '/settings/members',
      '/settings/audit',
      '/settings/billing',
      '/settings/provider-keys',
      '/settings/notifications',
      '/connections',
      '/approvals',
    ])
      expect(isSettingsPath(path), path).toBe(true);
    expect(isSettingsPath('/business')).toBe(false);
    expect(isSettingsPath('/projects')).toBe(false);
    expect(isSettingsPath('/settings/members/')).toBe(true);
  });

  it('every settings page is behind the sign-in guard', () => {
    for (const item of SETTINGS_ITEMS)
      expect(isProtectedPage(item.href.split('#')[0] ?? ''), item.href).toBe(true);
    expect(PROTECTED_PAGE_PREFIXES).toContain('/settings');
  });

  it('marks the current page, and Appearance only on its anchor', () => {
    expect(activeSettingsKey('/settings/billing')).toBe('billing');
    expect(activeSettingsKey('/connections')).toBe('connections');
    expect(activeSettingsKey('/account/profile')).toBe('profile');
    expect(activeSettingsKey('/account/profile', 'appearance')).toBe('appearance');
    expect(activeSettingsKey('/account/profile', 'email')).toBe('profile');
    expect(activeSettingsKey('/projects')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { isProtectedPage, pageGuardEnabled, safeNextPath, signInRedirectPath } from './page-guard';

describe('page guard (Phase 18 §2.3)', () => {
  it('protects the app pages, not the public ones', () => {
    expect(isProtectedPage('/projects')).toBe(true);
    expect(isProtectedPage('/projects/abc/review')).toBe(true);
    expect(isProtectedPage('/settings/members')).toBe(true);
    for (const path of ['/', '/pricing', '/sign-in', '/legal/terms', '/invite/x', '/projectsx']) {
      expect(isProtectedPage(path), path).toBe(false);
    }
  });

  it('sends a signed-out visitor to sign-in with a relative next', () => {
    expect(signInRedirectPath('/projects/p1', '?tab=2')).toBe(
      '/sign-in?next=%2Fprojects%2Fp1%3Ftab%3D2',
    );
    expect(signInRedirectPath('//evil.example', '')).toBe('/sign-in?next=%2Fprojects');
  });

  it('accepts only local paths as next (no open redirect, §5.9)', () => {
    expect(safeNextPath('/library?q=1')).toBe('/library?q=1');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:x',
    ]) {
      expect(safeNextPath(bad), bad).toBe('/projects');
    }
    expect(safeNextPath(null, '/welcome')).toBe('/welcome');
  });

  it('is on in standalone identity mode only', () => {
    expect(pageGuardEnabled({})).toBe(true);
    expect(pageGuardEnabled({ STUDIO_MODE: 'core' })).toBe(false);
    expect(pageGuardEnabled({ STUDIO_MODE: 'core', STUDIO_IDENTITY_MODE: 'standalone' })).toBe(
      true,
    );
    expect(pageGuardEnabled({ STUDIO_IDENTITY_MODE: 'core' })).toBe(false);
  });
});

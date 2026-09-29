import { describe, expect, it } from 'vitest';
import { landingDecision } from './session-hint';

// Phase 18 §3: `/` is the landing page; signed-in visitors (session cookie present) go to the app.

describe('landingDecision', () => {
  it('shows the landing page to visitors without a session cookie', () => {
    expect(landingDecision([], {})).toBe('landing');
    expect(landingDecision(['studio.locale', 'better-auth.session_token'], {})).toBe('landing');
  });

  it('sends a visitor with Studio’s session cookie to the app (HTTPS or local)', () => {
    expect(landingDecision(['__Secure-studio.session_token'], {})).toBe('app');
    expect(landingDecision(['studio.session_token'], { STUDIO_MODE: 'standalone' })).toBe('app');
  });

  it('core mode has no public pages: always the app', () => {
    expect(landingDecision([], { STUDIO_MODE: 'core' })).toBe('app');
    expect(landingDecision([], { STUDIO_IDENTITY_MODE: 'core' })).toBe('app');
  });
});

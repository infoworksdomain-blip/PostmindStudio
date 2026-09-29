import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors';
import { studioModes } from './mode';

describe('studioModes', () => {
  it('defaults to the standalone product', () => {
    expect(studioModes({})).toEqual({
      mode: 'standalone',
      identity: 'standalone',
      auditSink: 'local',
      email: 'resend',
      metaConnect: 'studio',
      billing: 'stripe',
      businesses: 'local',
    });
  });

  it('core mode keeps every pre-Phase-18 integration', () => {
    expect(studioModes({ STUDIO_MODE: 'core' })).toEqual({
      mode: 'core',
      identity: 'core',
      auditSink: 'core',
      email: 'none',
      metaConnect: 'core',
      billing: 'core',
      businesses: 'core',
    });
  });

  it('lets each integration be overridden on its own (case and blanks ignored)', () => {
    const modes = studioModes({
      STUDIO_MODE: ' Standalone ',
      STUDIO_AUDIT_SINK: 'both',
      STUDIO_BILLING: 'CORE',
      STUDIO_EMAIL_PROVIDER: '',
    });
    expect(modes).toMatchObject({ auditSink: 'both', billing: 'core', email: 'resend' });
  });

  it.each([
    ['STUDIO_MODE', 'hybrid'],
    ['STUDIO_IDENTITY_MODE', 'jwt'],
    ['STUDIO_AUDIT_SINK', 'none'],
    ['STUDIO_EMAIL_PROVIDER', 'ses'],
    ['STUDIO_META_CONNECT', 'engagement'],
    ['STUDIO_BILLING', 'paddle'],
    ['STUDIO_BUSINESSES', 'remote'],
  ])('rejects %s=%s instead of guessing', (name, value) => {
    expect(() => studioModes({ [name]: value })).toThrow(ConfigurationError);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireTenantContext, type TenantContext } from '../tenant';
import { createCoreIdentityProvider } from './core';
import { getIdentityProvider, setIdentityProvider } from './index';

afterEach(() => {
  setIdentityProvider(undefined);
  vi.unstubAllEnvs();
});

const tenant: TenantContext = {
  userId: 'u1',
  organisationId: 'org-1',
  organisation: { id: 'org-1' },
  memberships: [{ organisationId: 'org-1', role: 'owner' }],
  capabilities: ['studio:project:read'],
};

describe('identity provider selection (Phase 18 §2.2)', () => {
  it('requireTenantContext delegates to the configured provider', async () => {
    const resolve = vi.fn(async () => tenant);
    setIdentityProvider({ mode: 'standalone', resolve, invalidate: () => undefined });
    const req = new Request('https://studio.test/api/studio/projects');
    await expect(requireTenantContext(req)).resolves.toBe(tenant);
    expect(resolve).toHaveBeenCalledWith(req, undefined);
    // 20.10: the admin-route option is passed through.
    await requireTenantContext(req, { staffWithoutOrganisation: true });
    expect(resolve).toHaveBeenLastCalledWith(req, { staffWithoutOrganisation: true });
  });

  it('core mode wraps the Core resolver unchanged', async () => {
    const resolver = vi.fn(async () => tenant);
    const provider = createCoreIdentityProvider(resolver);
    expect(provider.mode).toBe('core');
    await expect(provider.resolve(new Request('https://studio.test/x'))).resolves.toBe(tenant);
    expect(() => provider.invalidate('u1')).not.toThrow();
  });

  it('STUDIO_IDENTITY_MODE=core builds the core provider from env', async () => {
    vi.stubEnv('STUDIO_IDENTITY_MODE', 'core');
    vi.stubEnv('POSTMIND_JWKS_URL', 'https://core.test/.well-known/jwks.json');
    vi.stubEnv('POSTMIND_JWT_ISSUER', 'postmind-core');
    vi.stubEnv('POSTMIND_JWT_AUDIENCE', 'postmind-studio');
    await expect(getIdentityProvider()).resolves.toMatchObject({ mode: 'core' });
  });

  it('an invalid mode is a configuration error, retried on the next call', async () => {
    vi.stubEnv('STUDIO_IDENTITY_MODE', 'nonsense');
    await expect(getIdentityProvider()).rejects.toThrow(/STUDIO_IDENTITY_MODE/);
    vi.stubEnv('STUDIO_IDENTITY_MODE', 'core');
    vi.stubEnv('POSTMIND_JWKS_URL', 'https://core.test/.well-known/jwks.json');
    vi.stubEnv('POSTMIND_JWT_ISSUER', 'postmind-core');
    vi.stubEnv('POSTMIND_JWT_AUDIENCE', 'postmind-studio');
    await expect(getIdentityProvider()).resolves.toMatchObject({ mode: 'core' });
  });
});

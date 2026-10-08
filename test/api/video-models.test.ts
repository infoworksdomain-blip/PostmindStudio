import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as videoModelsRoute from '../../src/app/api/studio/video-models/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { RunwayAdapter } from '../../src/lib/studio/providers/runway';
import { VeoAdapter } from '../../src/lib/studio/providers/veo';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 25.8 — GET /api/studio/video-models: auth, capability, and the caller's own plan tier
// (no database: the route reads only the tenant and the provider registry).

function onTier(organisationId: string, planTier: string, caps?: string[]): TenantContext {
  const t = tenant(organisationId, caps);
  return { ...t, organisation: { id: organisationId, planTier } };
}

const tokens = {
  basic: onTier('org-basic', 'BASIC'),
  plus: onTier('org-plus', 'PLUS'),
  reader: onTier('org-plus', 'PLUS', ['studio:project:read']),
  staff: { ...onTier('org-staff', 'STANDARD'), platformRole: 'staff' as const },
  outsider: 'forbidden' as const,
};

describe('GET /api/studio/video-models (25.8)', () => {
  beforeEach(() => {
    const { deps } = installApi(undefined as unknown as PrismaClient, tokens);
    setApiDeps({
      ...deps,
      registry: createProviderRegistry([
        new VeoAdapter({ apiKey: 'veo-secret-key', usdToGbpRate: 0.75 }),
        new RunwayAdapter({ apiKey: 'runway-secret-key', usdToGbpRate: 0.75 }),
      ]),
    });
  });

  afterAll(() => setApiDeps(undefined));

  it('needs a signed-in member with project write access', async () => {
    expect((await call(videoModelsRoute.GET)).status).toBe(401);
    expect((await call(videoModelsRoute.GET, { token: 'outsider' })).status).toBe(403);
    expect((await call(videoModelsRoute.GET, { token: 'reader' })).status).toBe(403);
  });

  it('lists the registered models of the caller’s tier, without secrets', async () => {
    const res = await call(videoModelsRoute.GET, {
      token: 'plus',
      path: '/api/studio/video-models',
    });
    expect(res.status).toBe(200);
    expect(res.json.planTier).toBe('PLUS');
    const models = res.json.models as Array<{ providerId: string; displayName: string }>;
    expect(models.map((m) => m.providerId)).toEqual(['veo', 'runway']);
    expect(models.map((m) => m.displayName)).toEqual(['Veo 3.1 Fast', 'Runway Gen-4.5']);
    expect(JSON.stringify(res.json)).not.toMatch(/secret-key/);
    // Customers never see generation cost.
    expect(models[0]).not.toHaveProperty('pencePerClip');
    expect(models[0]).not.toHaveProperty('relativeCost');
  });

  it('gives platform staff the price of a 6 s clip', async () => {
    const res = await call(videoModelsRoute.GET, { token: 'staff' });
    expect(res.json.models).toEqual([
      expect.objectContaining({ providerId: 'veo', pencePerClip: 45, relativeCost: 1 }),
      expect.objectContaining({ providerId: 'runway', pencePerClip: 54, relativeCost: 1 }),
    ]);
  });

  it('scopes the list to the organisation’s plan (Runway is not a BASIC candidate)', async () => {
    const res = await call(videoModelsRoute.GET, { token: 'basic' });
    expect(res.json.planTier).toBe('BASIC');
    expect((res.json.models as Array<{ providerId: string }>).map((m) => m.providerId)).toEqual([
      'veo',
    ]);
  });
});

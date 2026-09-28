import { describe, expect, it, vi } from 'vitest';
import { FeatureDisabledError } from '../../errors';
import type { FlagStore } from '../kill-switch';
import {
  createFeatureGate,
  featureEnabledByEnv,
  featureForProjectSource,
  featureKeys,
  FEATURES,
  featuresState,
  setFeature,
  setFeatureInput,
} from './features';

function store(values: Record<string, string>): FlagStore & { calls: number } {
  const s = {
    calls: 0,
    async getFlags(keys: readonly string[]) {
      s.calls += 1;
      return new Map(keys.flatMap((k) => (k in values ? [[k, values[k] as string]] : [])));
    },
  };
  return s;
}

describe('feature flags (15.D1 / A12.4)', () => {
  it('keys follow studio.features.<feature>[.org.<id>]', () => {
    expect(featureKeys.global('slideshow')).toBe('studio.features.slideshow');
    expect(featureKeys.organisation('image-library', 'org_1')).toBe(
      'studio.features.image-library.org.org_1',
    );
  });

  it('reads FEATURE_*_ENABLED: unset/true on, false off, junk fails closed', () => {
    expect(featureEnabledByEnv('library', {})).toBe(true);
    expect(featureEnabledByEnv('library', { FEATURE_LIBRARY_ENABLED: 'true' })).toBe(true);
    expect(featureEnabledByEnv('library', { FEATURE_LIBRARY_ENABLED: 'FALSE' })).toBe(false);
    expect(featureEnabledByEnv('image-library', { FEATURE_IMAGE_LIBRARY_ENABLED: 'nope' })).toBe(
      false,
    );
  });

  it('is on by default and off per organisation, globally or by env', async () => {
    const gate = createFeatureGate({
      store: store({
        'studio.features.overlays': 'false',
        'studio.features.slideshow.org.org_1': 'false',
      }),
      env: { FEATURE_IMAGE_LIBRARY_ENABLED: 'false' },
    });
    expect(await gate.status('library', 'org_1')).toEqual({ enabled: true });
    expect(await gate.status('overlays', 'org_2')).toEqual({ enabled: false, scope: 'global' });
    expect(await gate.status('slideshow', 'org_1')).toEqual({
      enabled: false,
      scope: 'organisation',
    });
    expect(await gate.status('slideshow', 'org_2')).toEqual({ enabled: true });
    expect(await gate.status('image-library', 'org_2')).toEqual({
      enabled: false,
      scope: 'environment',
    });
  });

  it('disabling one feature does not affect the others (A14.2)', async () => {
    const gate = createFeatureGate({ store: store({ 'studio.features.slideshow': 'false' }) });
    for (const feature of FEATURES.filter((f) => f !== 'slideshow'))
      await expect(gate.assertEnabled(feature, 'org_1')).resolves.toBeUndefined();
    await expect(gate.assertEnabled('slideshow', 'org_1')).rejects.toBeInstanceOf(
      FeatureDisabledError,
    );
  });

  it('assertEnabled throws 403 feature_disabled with the feature and scope', async () => {
    const gate = createFeatureGate({ store: store({ 'studio.features.library': 'false' }) });
    const err = await gate.assertEnabled('library', 'org_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureDisabledError);
    expect(err).toMatchObject({
      status: 403,
      code: 'feature_disabled',
      details: { feature: 'library', scope: 'global' },
    });
  });

  it('unrecognised flag values fail closed', async () => {
    const gate = createFeatureGate({ store: store({ 'studio.features.library': 'maybe' }) });
    expect((await gate.status('library', 'o')).enabled).toBe(false);
  });

  it('caches reads for the TTL (30 s) and invalidate() drops the cache', async () => {
    let now = 0;
    const values: Record<string, string> = {};
    const s = store(values);
    const gate = createFeatureGate({ store: s, now: () => now });
    await gate.status('library', 'o');
    values['studio.features.library'] = 'false';
    expect((await gate.status('library', 'o')).enabled).toBe(true);
    expect(s.calls).toBe(1);
    now = 30_001;
    expect((await gate.status('library', 'o')).enabled).toBe(false);
    values['studio.features.library'] = 'true';
    gate.invalidate();
    expect((await gate.status('library', 'o')).enabled).toBe(true);
  });

  it('store errors propagate (no silent enable)', async () => {
    const gate = createFeatureGate({
      store: { getFlags: vi.fn(async () => Promise.reject(new Error('db down'))) },
    });
    await expect(gate.status('library', 'o')).rejects.toThrow('db down');
  });

  it('maps project sources to features', () => {
    expect(featureForProjectSource('SLIDESHOW')).toBe('slideshow');
    expect(featureForProjectSource('LIBRARY_REFERENCE')).toBe('library');
    expect(featureForProjectSource('BRIEF')).toBeNull();
  });

  it('validates admin input', () => {
    const ok = { feature: 'slideshow', scope: 'global', enabled: false, reason: 'incident' };
    expect(setFeatureInput.safeParse(ok).success).toBe(true);
    expect(setFeatureInput.safeParse({ ...ok, scope: 'organisation' }).success).toBe(false);
    expect(setFeatureInput.safeParse({ ...ok, organisationId: 'org_1' }).success).toBe(false);
    expect(setFeatureInput.safeParse({ ...ok, feature: 'music' }).success).toBe(false);
    expect(setFeatureInput.safeParse({ ...ok, reason: 'x' }).success).toBe(false);
  });

  it('setFeature writes/deletes the right rows and featuresState summarises them', async () => {
    const rows = new Map<string, string>();
    const db = {
      systemFlag: {
        upsert: vi.fn(async (args: { where: { key: string }; create: { value: string } }) => {
          rows.set(args.where.key, args.create.value);
          return { key: args.where.key, value: args.create.value, updatedAt: new Date() };
        }),
        deleteMany: vi.fn(async (args: { where: { key: string } }) => {
          rows.delete(args.where.key);
          return { count: 1 };
        }),
        findMany: vi.fn(async () =>
          [...rows].map(([key, value]) => ({ key, value, updatedAt: new Date() })),
        ),
      },
    } as unknown as Parameters<typeof setFeature>[0];
    const base = { feature: 'slideshow' as const, reason: 'incident' };
    await setFeature(db, {
      ...base,
      scope: 'organisation',
      organisationId: 'org_1',
      enabled: false,
    });
    await setFeature(db, {
      ...base,
      scope: 'organisation',
      organisationId: 'org_2',
      enabled: false,
    });
    await setFeature(db, { ...base, feature: 'overlays', scope: 'global', enabled: false });
    let state = await featuresState(db, {});
    expect(state.features.slideshow).toEqual({
      global: true,
      environment: true,
      disabledFor: ['org_1', 'org_2'],
    });
    expect(state.features.overlays.global).toBe(false);
    expect(state.features.library).toEqual({ global: true, environment: true, disabledFor: [] });
    expect(state.propagationSec).toBe(30);
    const re = await setFeature(db, {
      ...base,
      scope: 'organisation',
      organisationId: 'org_1',
      enabled: true,
    });
    expect(re.value).toBeNull();
    state = await featuresState(db, { FEATURE_SLIDESHOW_ENABLED: 'false' });
    expect(state.features.slideshow).toEqual({
      global: true,
      environment: false,
      disabledFor: ['org_2'],
    });
  });
});

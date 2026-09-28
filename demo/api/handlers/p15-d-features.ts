// 15.D1 / A12.4 — /admin/features sample handlers: per-feature global switch plus
// per-organisation overrides, mirroring src/lib/studio/services/features.ts.
import { DemoHttpError, route } from '../registry';

const FEATURES = ['library', 'overlays', 'slideshow', 'image-library'] as const;
type Feature = (typeof FEATURES)[number];

const state: Record<Feature, { global: boolean; environment: boolean; disabledFor: string[] }> = {
  library: { global: true, environment: true, disabledFor: [] },
  overlays: { global: true, environment: true, disabledFor: [] },
  slideshow: { global: true, environment: true, disabledFor: ['org_pilot_bakery'] },
  'image-library': { global: true, environment: true, disabledFor: [] },
};

const snapshot = () => ({ features: structuredClone(state), propagationSec: 30 });

route('GET', '/admin/features', () => snapshot());

interface FeatureBody {
  feature?: string;
  scope?: string;
  organisationId?: string;
  enabled?: boolean;
  reason?: string;
}

route('PUT', '/admin/features', ({ body }) => {
  const input = (body ?? {}) as FeatureBody;
  const feature = FEATURES.find((f) => f === input.feature);
  if (!feature) throw new DemoHttpError(400, 'validation_error', 'Unknown feature');
  if (input.scope !== 'global' && input.scope !== 'organisation')
    throw new DemoHttpError(400, 'validation_error', 'scope must be global or organisation');
  if (typeof input.enabled !== 'boolean')
    throw new DemoHttpError(400, 'validation_error', 'enabled is required');
  if (!input.reason || input.reason.trim().length < 3)
    throw new DemoHttpError(400, 'validation_error', 'reason must be at least 3 characters');
  const entry = state[feature];
  if (input.scope === 'global') {
    entry.global = input.enabled;
    return snapshot();
  }
  const org = input.organisationId?.trim();
  if (!org) throw new DemoHttpError(400, 'validation_error', 'organisationId is required');
  entry.disabledFor = input.enabled
    ? entry.disabledFor.filter((o) => o !== org)
    : [...new Set([...entry.disabledFor, org])].sort();
  return snapshot();
});

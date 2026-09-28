import { appendFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canaryAnnotations,
  PROVIDER_CANARY_ENV,
  providerCanaryKeys,
  runProviderCanary,
  type ProviderCanaryResult,
} from '../../src/lib/studio/providers/canary';

// BACKLOG 15.D10 / spec §20 — daily provider canary (vitest.canary.config.ts;
// .github/workflows/platform-canary.yml, job "providers"). Each provider whose CANARY_* staging
// secrets are set runs its adapter's healthCheck() live; Deprecation / Sunset headers seen on
// the way are written as GitHub ::warning annotations to CANARY_ANNOTATIONS_FILE (the workflow
// prints that file). Providers without secrets are skipped. Never part of `npm test`.

const results: ProviderCanaryResult[] = [];

describe('provider canary (live, read-only health checks)', () => {
  for (const providerId of Object.keys(PROVIDER_CANARY_ENV)) {
    const keys = providerCanaryKeys(providerId);
    it.skipIf(!keys)(`${providerId}: staging key accepted, provider healthy`, async () => {
      const result = await runProviderCanary(providerId, keys as string[]);
      results.push(result);
      expect(result.healthy, result.reason ?? '').toBe(true);
    });
  }
});

afterAll(() => {
  const file = process.env.CANARY_ANNOTATIONS_FILE?.trim();
  if (!file) return;
  const lines = canaryAnnotations(results);
  if (lines.length > 0) appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
});

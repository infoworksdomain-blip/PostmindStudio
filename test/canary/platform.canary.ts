import { describe, expect, it } from 'vitest';
import {
  CANARY_ENV,
  canaryCredentials,
  runPlatformCanary,
  type CanaryPlatform,
} from '../../src/lib/studio/platforms/canary';

// BACKLOG 13.31 — daily platform canary (vitest.canary.config.ts; .github/workflows/
// platform-canary.yml). One live, read-only call per platform whose sandbox secrets are set;
// platforms without secrets are skipped. Never part of `npm test`.

const PLATFORMS = Object.keys(CANARY_ENV) as CanaryPlatform[];

describe('platform canary (live, read-only)', () => {
  for (const platform of PLATFORMS) {
    const creds = canaryCredentials(platform);
    it.skipIf(!creds)(
      `${platform}: sandbox token accepted and response shape unchanged`,
      async () => {
        const result = await runPlatformCanary(
          platform,
          creds as NonNullable<typeof creds>,
          globalThis.fetch,
          process.env.META_GRAPH_API_VERSION?.trim() || undefined,
        );
        expect(result.ok).toBe(true);
      },
    );
  }
});

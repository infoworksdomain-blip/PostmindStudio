import { NoProviderAvailableError } from '../src/lib/errors';
import { createKillSwitch, createPrismaFlagStore } from '../src/lib/studio/kill-switch';
import {
  createPrismaBudgetChecker,
  orgProviderDailyCapFromEnv,
} from '../src/lib/studio/providers/budget';
import { createCircuitBreaker } from '../src/lib/studio/providers/circuit-breaker';
import { getProviderRegistry } from '../src/lib/studio/providers/default-registry';
import {
  routeProvider,
  type RouteInput,
  type RouterDeps,
} from '../src/lib/studio/providers/router';
import { createHarness, main, out, SMOKE_ORG_ID } from './lib/harness';

// GATE 2 router check (FIRST_PROMPTS Prompt 10). Uses the REAL registry built from
// .env.local, the real kill switch and budget checker. No provider is called: Runway's
// failures are simulated by feeding the circuit breaker directly.
//
//   1. AI_CLIP shot on STANDARD → spec 6.4 order is [luma, runway, kling].
//      With only Runway configured, Runway is selected (Luma skipped: not_configured).
//   2. Record 5 Runway failures → breaker opens.
//   3. Route again → Runway skipped (circuit_open); the next configured candidate wins,
//      or NO_PROVIDER_AVAILABLE if no fallback provider is configured yet.
// Run: npm run gate2:router

main(async () => {
  const { prisma } = createHarness();
  try {
    const breaker = createCircuitBreaker();
    const deps: RouterDeps = {
      registry: getProviderRegistry(),
      breaker,
      killSwitch: createKillSwitch({ store: createPrismaFlagStore(prisma) }),
      budget: createPrismaBudgetChecker(prisma, {
        orgProviderDailyCapPence: orgProviderDailyCapFromEnv(),
      }),
    };
    out(
      `configured providers: ${
        deps.registry
          .list()
          .map((a) => a.providerId)
          .join(', ') || '(none)'
      }`,
    );

    const input: RouteInput = {
      need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 5 },
      planTier: 'STANDARD',
      organisationId: SMOKE_ORG_ID,
      request: {
        capability: 'text_to_video',
        organisationId: SMOKE_ORG_ID,
        prompt: 'router smoke test (never submitted)',
        durationSec: 5,
        aspectRatio: '9:16',
      },
    };

    const first = await routeProvider(input, deps);
    out(`1. selected: ${first.providerId}`);
    out(`   candidates: ${JSON.stringify(first.candidates)}`);
    if (first.providerId !== 'runway') {
      out(`✗ expected runway (only Runway of [luma, runway, kling] should be configured)`);
      return false;
    }

    for (let i = 1; i <= 5; i += 1) breaker.recordFailure('runway');
    out(`2. simulated 5 Runway failures → breaker: ${breaker.state('runway')}`);

    try {
      const second = await routeProvider(input, deps);
      out(`3. selected fallback: ${second.providerId}`);
      out(`   candidates: ${JSON.stringify(second.candidates)}`);
      return second.candidates.some(
        (c) => c.providerId === 'runway' && c.skipped === 'circuit_open',
      );
    } catch (err) {
      if (!(err instanceof NoProviderAvailableError)) throw err;
      out(
        '3. NO_PROVIDER_AVAILABLE — Runway correctly routed around; no fallback provider configured yet',
      );
      out(`   candidates: ${JSON.stringify(err.details?.candidates)}`);
      const candidates = (err.details?.candidates ?? []) as Array<{
        providerId: string;
        skipped?: string;
      }>;
      return candidates.some((c) => c.providerId === 'runway' && c.skipped === 'circuit_open');
    }
  } finally {
    await prisma.$disconnect();
  }
});

import { requireEnv } from '../src/lib/env';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { ShotstackAdapter } from '../src/lib/studio/providers/shotstack';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// GATE 2 smoke test for Shotstack composition. Renders a 3-second 9:16 title card. The real
// edit decision list builder arrives in BACKLOG 3.6; this only proves the render round-trip.
// Use SHOTSTACK_ENVIRONMENT=stage (free, watermarked) for this test.
// Run: npm run gate2:shotstack

main(async () => {
  const { prisma, deps } = createHarness();
  try {
    const adapter = new ShotstackAdapter({
      apiKey: requireEnv('SHOTSTACK_API_KEY'),
      environment: process.env.SHOTSTACK_ENVIRONMENT || 'stage',
      usdToGbpRate: usdToGbpRateFromEnv(),
    });

    const health = await adapter.healthCheck();
    out(`health: ${JSON.stringify(health)}`);
    if (!health.healthy) return false;

    const { jobId, result } = await runTrackedJob(
      adapter,
      {
        capability: 'composition',
        organisationId: SMOKE_ORG_ID,
        outputDurationSec: 3,
        edit: {
          timeline: {
            background: '#1f1b16',
            tracks: [
              {
                clips: [
                  {
                    asset: { type: 'rich-text', text: 'PostMind Studio · GATE 2' },
                    start: 0,
                    length: 3,
                    transition: { in: 'fade', out: 'fade' },
                  },
                ],
              },
            ],
          },
          output: { format: 'mp4', resolution: 'sd', aspectRatio: '9:16' },
        },
      },
      deps,
    );

    out();
    out(`result: ${result.state}`);
    if (result.output?.url) out(`render URL (temporary, 24h): ${result.output.url}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

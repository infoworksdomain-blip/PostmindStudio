import { requireEnv } from '../src/lib/env';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { RunwayAdapter } from '../src/lib/studio/providers/runway';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// GATE 2 (BACKLOG): "submit a Runway generation, poll, retrieve URL".
// Generates one 5-second 9:16 gen4.5 text-to-video clip. COSTS REAL CREDITS: 60 credits ($0.60).
// Run: npm run gate2:runway

main(async () => {
  const { prisma, deps } = createHarness();
  try {
    const adapter = new RunwayAdapter({
      apiKey: requireEnv('RUNWAY_API_KEY'),
      usdToGbpRate: usdToGbpRateFromEnv(),
    });

    const health = await adapter.healthCheck();
    out(`health: ${JSON.stringify(health)}`);
    if (!health.healthy) return false;

    const { jobId, result } = await runTrackedJob(
      adapter,
      {
        capability: 'text_to_video',
        organisationId: SMOKE_ORG_ID,
        prompt:
          'Slow push-in on a golden sourdough loaf on a flour-dusted wooden counter, morning window light, steam rising.',
        durationSec: 5,
        aspectRatio: '9:16',
      },
      deps,
      { timeoutMs: 15 * 60_000 },
    );

    out();
    out(`result: ${result.state}`);
    if (result.output?.url) out(`video URL (expires within 24–48h): ${result.output.url}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

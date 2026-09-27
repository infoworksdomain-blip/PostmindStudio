import { requireEnv } from '../src/lib/env';
import { LumaAdapter } from '../src/lib/studio/providers/luma';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// BACKLOG 13.32 gate: "submit a Luma generation, poll, retrieve URL" (like gate2:runway).
// Generates one 5-second 9:16 ray-3.2 720p text-to-video clip. COSTS REAL MONEY: $0.30
// (docs.agents.lumalabs.ai/guides/pricing). Run: npm run gate2:luma

main(async () => {
  const { prisma, deps } = createHarness();
  try {
    const adapter = new LumaAdapter({
      apiKey: requireEnv('LUMA_API_KEY'),
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
    if (result.output?.url) out(`video URL (expires within 1h): ${result.output.url}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

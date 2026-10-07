import { ConfigurationError } from '../src/lib/errors';
import { createFalModelAdapter } from '../src/lib/studio/providers/fal';
import { FAL_VIDEO_MODEL_KEYS, isFalVideoModelKey } from '../src/lib/studio/providers/fal-models';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// BACKLOG 24.1 gate: one fal.ai model on its own (no router, no STUDIO_FAL_VIDEO_MODELS), like
// gate2:luma. Generates ONE 6-second 9:16 text-to-video clip. COSTS REAL MONEY (FAL_KEY's prepaid
// balance): minimax-h3-max ~$0.48, ltx-2.3-fast ~$0.36, veo-3.1-lite ~$0.18 (plans/24.1-fal-video.md).
// Run: npm run gate2:fal -- <model>   (one of minimax-h3-max, ltx-2.3-fast, veo-3.1-lite)

main(async () => {
  const model = process.argv[2] ?? '';
  if (!isFalVideoModelKey(model)) {
    throw new ConfigurationError(`Pass a fal model: ${FAL_VIDEO_MODEL_KEYS.join(', ')}`);
  }
  const { prisma, deps } = createHarness();
  try {
    const adapter = createFalModelAdapter(model, { usdToGbpRate: usdToGbpRateFromEnv() });

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
        durationSec: 6,
        aspectRatio: '9:16',
        resolution: '720p',
      },
      deps,
      { timeoutMs: 15 * 60_000 },
    );

    out();
    out(`result: ${result.state}`);
    if (result.output?.url) out(`video URL (fal CDN, temporary): ${result.output.url}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

import { requireEnv } from '../src/lib/env';
import { HeyGenAdapter } from '../src/lib/studio/providers/heygen';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// BACKLOG 13.32 gate: "submit a HeyGen avatar video, poll, retrieve URL" (like gate2:runway).
// Lip-syncs HEYGEN_AVATAR_ID to the audio at HEYGEN_TEST_AUDIO_URL (a public HTTPS MP3/WAV;
// in the pipeline this is the shot's ElevenLabs narration). COSTS REAL MONEY: $0.05 per second
// of output on Avatar IV (developers.heygen.com/docs/enterprise-pricing).
// Run: npm run gate2:heygen

main(async () => {
  const { prisma, deps } = createHarness();
  try {
    const adapter = new HeyGenAdapter({
      apiKey: requireEnv('HEYGEN_API_KEY'),
      defaultAvatarId: requireEnv('HEYGEN_AVATAR_ID'),
      usdToGbpRate: usdToGbpRateFromEnv(),
    });

    const health = await adapter.healthCheck();
    out(`health: ${JSON.stringify(health)}`);
    if (!health.healthy) return false;

    const durationSec = Number(process.env.HEYGEN_TEST_AUDIO_SEC || '10');
    const { jobId, result } = await runTrackedJob(
      adapter,
      {
        capability: 'avatar_video',
        organisationId: SMOKE_ORG_ID,
        audioUrl: requireEnv('HEYGEN_TEST_AUDIO_URL'),
        durationSec,
        aspectRatio: '9:16',
      },
      deps,
      { timeoutMs: 20 * 60_000 },
    );

    out();
    out(`result: ${result.state}`);
    if (result.output?.url) out(`video URL: ${result.output.url}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

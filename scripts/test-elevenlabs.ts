import { requireEnv } from '../src/lib/env';
import { ElevenLabsAdapter } from '../src/lib/studio/providers/elevenlabs';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { assetsBucket, getAssetStorage } from '../src/lib/studio/storage';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// GATE 2 smoke test for ElevenLabs TTS. Writes one MP3 to S3_BUCKET_ASSETS.
// Needs ELEVENLABS_VOICE_ID (any voice id from your ElevenLabs voice library) plus AWS creds.
// Run: npm run gate2:elevenlabs

main(async () => {
  const { prisma, deps } = createHarness();
  try {
    const adapter = new ElevenLabsAdapter({
      apiKey: requireEnv('ELEVENLABS_API_KEY'),
      storage: getAssetStorage(),
      bucket: assetsBucket(),
      model: process.env.ELEVENLABS_MODEL || undefined,
      usdToGbpRate: usdToGbpRateFromEnv(),
    });

    const health = await adapter.healthCheck();
    out(`health: ${JSON.stringify(health)}`);
    if (!health.healthy) return false;

    const { jobId, result } = await runTrackedJob(
      adapter,
      {
        capability: 'tts',
        organisationId: SMOKE_ORG_ID,
        text: 'Fresh sourdough, baked this morning in Leeds, delivered to your door every week.',
        voiceId: requireEnv('ELEVENLABS_VOICE_ID'),
        languageCode: 'en',
      },
      deps,
    );

    out();
    out(`result: ${result.state}`);
    if (result.output?.url) out(`audio URL (signed, 24h): ${result.output.url}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

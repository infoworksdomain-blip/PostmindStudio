import Anthropic from '@anthropic-ai/sdk';
import { requireEnv } from '../src/lib/env';
import { AnthropicAdapter } from '../src/lib/studio/providers/anthropic';
import { usdToGbpRateFromEnv } from '../src/lib/studio/providers/pricing';
import { createHarness, main, out, printJobRow, runTrackedJob, SMOKE_ORG_ID } from './lib/harness';

// GATE 2, first real provider call (FIRST_PROMPTS Prompt 8):
// ideation prompt → Claude → response printed → provider_jobs row verified.
// Run: npm run gate2:anthropic

main(async () => {
  const { prisma, deps } = createHarness();
  try {
    const adapter = new AnthropicAdapter({
      client: new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') }),
      model: process.env.ANTHROPIC_MODEL || undefined,
      usdToGbpRate: usdToGbpRateFromEnv(),
    });

    const { jobId, result } = await runTrackedJob(
      adapter,
      {
        capability: 'text_generation',
        organisationId: SMOKE_ORG_ID,
        system:
          'You are the ideation layer of PostMind Studio. Turn a business brief into one concrete short-form video brief.',
        prompt:
          'Brief: a family bakery in Leeds launching a sourdough subscription. Audience: local professionals aged 25–40. Platform: TikTok.',
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['hook', 'keyMessage', 'targetAudience', 'tone', 'callToAction'],
          properties: {
            hook: { type: 'string' },
            keyMessage: { type: 'string' },
            targetAudience: { type: 'string' },
            tone: { type: 'string' },
            callToAction: { type: 'string' },
          },
        },
      },
      deps,
    );

    out();
    out(`result: ${result.state}`);
    out(JSON.stringify(result.output?.metadata ?? result.error, null, 2));
    return result.state === 'succeeded' && (await printJobRow(prisma, jobId));
  } finally {
    await prisma.$disconnect();
  }
});

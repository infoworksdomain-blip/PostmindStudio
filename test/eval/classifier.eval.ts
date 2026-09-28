import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/lib/studio/providers/anthropic';
import { usdToGbpRateFromEnv } from '../../src/lib/studio/providers/pricing';
import {
  BUSINESS_PROFILE_SCHEMA,
  buildClassifyPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  parseClassifiedProfile,
} from '../../src/lib/studio/scan/classify';
import { crawlSite } from '../../src/lib/studio/scan/crawl';
import { PoliteFetcher } from '../../src/lib/studio/scan/fetch';
import { guardedFetch } from '../../src/lib/studio/scan/safe-fetch';
import {
  accuracy,
  CLASSIFIER_ACCURACY_THRESHOLD,
  CLASSIFIER_SET_SIZE,
  gradeClassification,
  loadClassifierManifest,
  notTheRealSet,
  type EvalOutcome,
  type LabelledSite,
} from './manifest';

// BACKLOG 15.D10 / A14.2 "Business classifier accuracy >85% on the 50-site labelled test set".
// Operator-run (vitest.eval.config.ts; `npm run test:eval`): each labelled site is crawled
// live with the production crawler (robots-respecting PoliteFetcher over the SSRF-guarded
// fetch) and classified with the production prompt + schema through the Anthropic adapter
// (ANTHROPIC_API_KEY, staging key). The accuracy assertion runs only on the real H-03
// manifest; without it (or with the illustrative example) the suite is skipped with the reason.

const manifest = loadClassifierManifest();
const why =
  notTheRealSet(manifest, CLASSIFIER_SET_SIZE) ??
  (process.env.ANTHROPIC_API_KEY?.trim() ? null : 'ANTHROPIC_API_KEY is not set');

async function classify(adapter: AnthropicAdapter, site: LabelledSite): Promise<EvalOutcome> {
  const fetcher = new PoliteFetcher({
    fetchImpl: guardedFetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
  const crawl = await crawlSite(site.url, { fetcher });
  if (crawl.robotsBlocked || crawl.pages.length === 0) {
    return {
      id: site.id,
      correct: false,
      detail: crawl.robotsBlocked ? 'robots blocked' : 'no pages',
    };
  }
  const { providerJobId } = await adapter.submit({
    capability: 'text_generation',
    organisationId: 'eval',
    system: CLASSIFY_SYSTEM_PROMPT,
    prompt: buildClassifyPrompt({ siteUrl: site.url, pages: crawl.pages }),
    maxTokens: 2_000,
    outputSchema: BUSINESS_PROFILE_SCHEMA as unknown as Record<string, unknown>,
  });
  const result = await adapter.poll(providerJobId);
  if (result.state !== 'succeeded') {
    return { id: site.id, correct: false, detail: `classifier failed: ${result.error?.message}` };
  }
  const profile = parseClassifiedProfile(
    (result.output?.metadata as { json?: unknown } | undefined)?.json,
  );
  return {
    id: site.id,
    correct: gradeClassification(site, profile),
    detail: `${profile.industry} | ${profile.subNiche}`,
  };
}

describe.skipIf(why !== null)(
  `business classifier accuracy (A14.2)${why ? ` (skipped: ${why})` : ''}`,
  () => {
    it(`is above ${CLASSIFIER_ACCURACY_THRESHOLD * 100}% on the labelled set`, async () => {
      const adapter = new AnthropicAdapter({
        client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? '' }),
        model: process.env.ANTHROPIC_MODEL?.trim() || undefined,
        usdToGbpRate: usdToGbpRateFromEnv(),
      });
      const outcomes: EvalOutcome[] = [];
      for (const site of manifest?.sites ?? []) {
        outcomes.push(
          await classify(adapter, site).catch((err: Error) => ({
            id: site.id,
            correct: false,
            detail: `error: ${err.message}`,
          })),
        );
      }
      const wrong = outcomes.filter((o) => !o.correct);
      expect(
        accuracy(outcomes),
        `misclassified: ${JSON.stringify(wrong, null, 1)}`,
      ).toBeGreaterThan(CLASSIFIER_ACCURACY_THRESHOLD);
    });
  },
);

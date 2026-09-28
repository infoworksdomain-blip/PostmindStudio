import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ConfigurationError } from '../../../src/lib/errors';
import type { GateCommand } from '../../../src/lib/studio/ops/staging-gate/args';
import {
  estimateLines,
  LIVE_PROVIDER_TESTS,
  liveSections,
  missingEnv,
  POST_VIDEO_ENV,
  postTargets,
  testPostOptions,
  type LiveProviderTest,
  type PlannedPost,
  type PlannedTest,
  type TestOutcome,
} from '../../../src/lib/studio/ops/staging-gate/live-providers';
import type { GateReport } from '../../../src/lib/studio/ops/staging-gate/report';
import type { AspectRatio, ProviderAdapter } from '../../../src/lib/studio/providers/interface';
import { buildAdaptersFromEnv } from '../../../src/lib/studio/providers/default-registry';
import { ElevenLabsVoiceCloning } from '../../../src/lib/studio/providers/elevenlabs-voices';
import type { PlatformPublisher, VideoSource } from '../../../src/lib/studio/platforms/interface';
import { createPublisherRegistry } from '../../../src/lib/studio/platforms/registry';
import { createHarness, runTrackedJob } from '../../lib/harness';
import { baseContext, NEEDS_SHELL_FOR_NPM, optionalEnv, out, runProcess, sleep } from './common';

// 14.8 — `staging-gate.ts --live-providers [--confirm]` (npm run gate:live). Spends real money
// and posts to real (test) accounts, so it prints the plan + cost estimate and refuses to run
// without --confirm. Env: every provider key you want exercised, DATABASE_URL (staging:
// provider_jobs rows), LIVE_TEST_MEDIA_URL (+ _SEC) for Hive/AssemblyAI, LIVE_TEST_VOICE_SAMPLE_PATH,
// LIVE_TEST_VIDEO_PATH + LIVE_TEST_VIDEO_URL (+ _SEC, _ASPECT) and LIVE_<PLATFORM>_ACCESS_TOKEN /
// LIVE_<PLATFORM>_ACCOUNT_ID per platform test account (runbooks/staging-gate.md).

type LiveCommand = Extract<GateCommand, { kind: 'live-providers' }>;

interface Estimating {
  estimateCostPence(request: unknown): number;
}

function hasEstimator(adapter: ProviderAdapter): adapter is ProviderAdapter & Estimating {
  return typeof (adapter as Partial<Estimating>).estimateCostPence === 'function';
}

function adapterFor(adapters: ProviderAdapter[], test: LiveProviderTest, env: NodeJS.ProcessEnv) {
  const request = test.request?.(env);
  return adapters.find(
    (a) =>
      a.providerId === test.providerId && (!request || a.capabilities.includes(request.capability)),
  );
}

function planTests(cmd: LiveCommand, adapters: ProviderAdapter[]): PlannedTest[] {
  const env = process.env;
  return LIVE_PROVIDER_TESTS.map((test) => {
    if (!cmd.providers) return { test, skipReason: '--no-providers', estimatePence: null };
    if (cmd.only && !cmd.only.includes(test.id)) {
      return { test, skipReason: 'not in --only', estimatePence: null };
    }
    const missing = missingEnv(test, env);
    if (missing.length) {
      return { test, skipReason: `missing ${missing.join(', ')}`, estimatePence: null };
    }
    if (test.kind === 'voice-clone') return { test, estimatePence: 0 };
    if (!test.request) return { test, estimatePence: 0 };
    const adapter = adapterFor(adapters, test, env);
    const estimatePence =
      adapter && hasEstimator(adapter) ? adapter.estimateCostPence(test.request(env)) : null;
    return { test, estimatePence };
  });
}

function planPosts(cmd: LiveCommand, publishers: Record<string, PlatformPublisher>): PlannedPost[] {
  const videoMissing = POST_VIDEO_ENV.filter((n) => !optionalEnv(n));
  return postTargets().map((target) => {
    const takedownSupported = typeof publishers[target.platform]?.takedown === 'function';
    if (!cmd.posts) return { target, skipReason: '--no-posts', takedownSupported };
    if (cmd.only && !cmd.only.includes(target.platform)) {
      return { target, skipReason: 'not in --only', takedownSupported };
    }
    const missing = [target.tokenEnv, target.accountEnv, ...videoMissing].filter(
      (n) => !optionalEnv(n),
    );
    return missing.length
      ? { target, skipReason: `missing ${missing.join(', ')}`, takedownSupported }
      : { target, takedownSupported };
  });
}

async function runProviderTest(
  planned: PlannedTest,
  adapters: ProviderAdapter[],
): Promise<TestOutcome> {
  const { test } = planned;
  if (planned.skipReason) return { id: test.id, ok: null, detail: planned.skipReason };
  out(`\n→ ${test.id}`);
  try {
    if (test.kind === 'script') {
      const run = await runProcess('npm', ['run', test.npmScript ?? ''], {
        shell: NEEDS_SHELL_FOR_NPM,
      });
      return {
        id: test.id,
        ok: run.exitCode === 0,
        detail: `npm run ${test.npmScript} exited ${run.exitCode} after ${(run.durationMs / 1000).toFixed(0)}s`,
      };
    }
    if (test.kind === 'voice-clone') {
      const path = optionalEnv('LIVE_TEST_VOICE_SAMPLE_PATH') ?? '';
      const cloning = new ElevenLabsVoiceCloning({
        apiKey: optionalEnv('ELEVENLABS_API_KEY') ?? '',
      });
      const voice = await cloning.addVoice({
        name: `staging-gate ${new Date().toISOString().slice(0, 16)}`,
        description: 'PostMind Studio staging gate test voice (deleted immediately)',
        samples: [
          { bytes: readFileSync(path), filename: basename(path), contentType: 'audio/mpeg' },
        ],
      });
      await cloning.deleteVoice(voice.voiceId);
      return { id: test.id, ok: true, detail: `cloned ${voice.voiceId}, then deleted it` };
    }
    const adapter = adapterFor(adapters, test, process.env);
    if (!adapter || !test.request) {
      return { id: test.id, ok: false, detail: `${test.providerId} adapter not configured` };
    }
    const { prisma, deps } = createHarness();
    try {
      const { jobId, result } = await runTrackedJob(adapter, test.request(process.env), deps, {
        timeoutMs: 20 * 60_000,
      });
      return {
        id: test.id,
        ok: result.state === 'succeeded',
        detail: `${result.state} (provider_jobs ${jobId})${result.error ? `: ${result.error.message}` : ''}`,
      };
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    return { id: test.id, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function testVideo(): VideoSource {
  const bytes = readFileSync(optionalEnv('LIVE_TEST_VIDEO_PATH') ?? '');
  const aspect = (optionalEnv('LIVE_TEST_VIDEO_ASPECT') ?? '9:16') as AspectRatio;
  if (!['9:16', '16:9', '1:1', '4:5'].includes(aspect)) {
    throw new ConfigurationError('LIVE_TEST_VIDEO_ASPECT must be 9:16, 16:9, 1:1 or 4:5');
  }
  return {
    sizeBytes: bytes.byteLength,
    contentType: 'video/mp4',
    durationSec: Number(optionalEnv('LIVE_TEST_VIDEO_SEC') ?? '10'),
    aspectRatio: aspect,
    signedUrl: optionalEnv('LIVE_TEST_VIDEO_URL') ?? '',
    read: async (start, endInclusive) => bytes.subarray(start, endInclusive + 1),
  };
}

async function runPost(
  planned: PlannedPost,
  publishers: Record<string, PlatformPublisher>,
): Promise<TestOutcome> {
  const { platform, tokenEnv, accountEnv } = planned.target;
  if (planned.skipReason) return { id: platform, ok: null, detail: planned.skipReason };
  out(`\n→ post to ${platform}`);
  const publisher = publishers[platform] as PlatformPublisher;
  const accessToken = optionalEnv(tokenEnv) ?? '';
  const accountId = optionalEnv(accountEnv) ?? '';
  const caption = 'PostMind Studio staging gate test post. It will be deleted.';
  try {
    const result = await publisher.publish({
      video: testVideo(),
      text: caption,
      caption,
      hashtags: [],
      title: 'PostMind Studio staging gate test',
      accessToken,
      accountId,
      aiGenerated: true,
      options: testPostOptions(platform),
    });
    const where = result.platformUrl ?? `post id ${result.platformPostId}`;
    if (!publisher.takedown) {
      return {
        id: platform,
        ok: true,
        detail: `posted (${where}). ${platform} has no delete API: REMOVE IT BY HAND in the test account.`,
      };
    }
    await sleep(5_000);
    await publisher.takedown({ accessToken, accountId, platformPostId: result.platformPostId });
    return { id: platform, ok: true, detail: `posted (${where}) and taken down via the API` };
  } catch (err) {
    return { id: platform, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Returns null when --confirm is missing (the estimate is printed, nothing is spent). */
export async function runLiveProviders(cmd: LiveCommand): Promise<GateReport | null> {
  const startedAt = new Date().toISOString();
  const adapters = buildAdaptersFromEnv();
  const publishers = createPublisherRegistry({
    fetchImpl: fetch,
    sleep,
    now: Date.now,
    graphVersion: optionalEnv('META_GRAPH_API_VERSION'),
  }) as Record<string, PlatformPublisher>;
  const tests = planTests(cmd, adapters);
  const posts = planPosts(cmd, publishers);
  const estimate = estimateLines(tests, posts);
  out(estimate.join('\n'));
  if (!cmd.confirm) {
    out(
      '\nNothing was run. Re-run with --confirm to spend the amount above and post to the test accounts.',
    );
    return null;
  }
  const testOutcomes: TestOutcome[] = [];
  for (const t of tests) testOutcomes.push(await runProviderTest(t, adapters));
  const postOutcomes: TestOutcome[] = [];
  for (const p of posts) postOutcomes.push(await runPost(p, publishers));
  const { verdict, sections } = liveSections({
    tests: testOutcomes,
    posts: postOutcomes,
    estimate,
  });
  return {
    check: 'live-providers',
    title: 'Live provider and posting run (14.8)',
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    context: baseContext(cmd.operator),
    sections,
    data: { tests: testOutcomes, posts: postOutcomes },
  };
}

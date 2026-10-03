import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ProviderError } from '../../errors';
import { noteProviderWait } from '../pipeline/provider-wait';
import {
  createSimulatedRegistry,
  SimulatedAdapter,
  simulatedEmbedding,
  simulatedText,
  SIM_SCRIPT,
  variedScript,
  type SimulationProfile,
} from './fake-providers';
import {
  ALLOW_PRODUCTION_VALUE,
  assertFakeProvidersAllowed,
  fakeProvidersRequested,
  localOnlyFetch,
} from './guard';
import { contentTypeOf, createLocalStorage, objectPath } from './local-storage';
import {
  distribution,
  failureClass,
  percentile,
  renderMarkdown,
  summarise,
  type ProjectOutcome,
} from './report';
import { sampleMediaCommands } from './sample-media';

// 20.29 load-test harness: the guard, the simulated providers, local storage and the report.

describe('fake-provider guard', () => {
  it('needs the explicit flag', () => {
    expect(fakeProvidersRequested({})).toBe(false);
    expect(() => assertFakeProvidersAllowed({})).toThrow(ConfigurationError);
    expect(() => assertFakeProvidersAllowed({ STUDIO_FAKE_PROVIDERS: '1' })).not.toThrow();
  });

  it('refuses production unless the separate opt-in is set', () => {
    const prod = { STUDIO_FAKE_PROVIDERS: '1', NODE_ENV: 'production' };
    expect(() => assertFakeProvidersAllowed(prod)).toThrow(/refuse a production/);
    expect(() =>
      assertFakeProvidersAllowed({ ...prod, STUDIO_FAKE_PROVIDERS_ALLOW_PRODUCTION: 'yes' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      assertFakeProvidersAllowed({
        ...prod,
        STUDIO_ENV: 'production',
        STUDIO_FAKE_PROVIDERS_ALLOW_PRODUCTION: ALLOW_PRODUCTION_VALUE,
      }),
    ).not.toThrow();
  });

  it('never runs against the live domain, even with the opt-in', () => {
    expect(() =>
      assertFakeProvidersAllowed({
        STUDIO_FAKE_PROVIDERS: '1',
        APP_URL: 'https://studio.postmindai.pro',
        STUDIO_FAKE_PROVIDERS_ALLOW_PRODUCTION: ALLOW_PRODUCTION_VALUE,
      }),
    ).toThrow(/live service/);
    expect(() =>
      assertFakeProvidersAllowed({ STUDIO_FAKE_PROVIDERS: '1', APP_URL: 'not a url' }),
    ).not.toThrow();
  });

  it('fetch only reaches this machine', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const local = localOnlyFetch(inner as unknown as typeof fetch);
    await local('http://127.0.0.1:9/x');
    await local(new URL('http://localhost/y'));
    await local(new Request('data:text/plain,hi'));
    await expect(local('https://api.byteplus.com/v3/tasks')).rejects.toThrow(ConfigurationError);
    expect(inner).toHaveBeenCalledTimes(3);
  });
});

function profile(overrides: Partial<SimulationProfile> = {}) {
  let now = 0;
  const p: SimulationProfile = {
    timeScale: 1,
    rateLimitedRatio: 0,
    failRatio: 0,
    accountConcurrency: { seedance: 2 },
    random: () => 0.5,
    now: () => now,
    ...overrides,
  };
  return { p, advance: (ms: number) => (now += ms) };
}

const clipRequest = (organisationId: string) =>
  ({
    capability: 'text_to_video',
    organisationId,
    prompt: 'bread',
    durationSec: 4,
    aspectRatio: '9:16',
  }) as const;

describe('SimulatedAdapter', () => {
  it('runs for its simulated latency, then returns the scripted output', async () => {
    const { p, advance } = profile({ timeScale: 0.1 });
    const adapter = new SimulatedAdapter('seedance', ['text_to_video'], {
      latencySec: [30, 180],
      costPence: 19,
      respond: async () => ({
        state: 'succeeded',
        output: { url: 'http://127.0.0.1/c.mp4', metadata: {} },
      }),
      profile: p,
      flaky: true,
    });
    expect(adapter.typicalLatencySec).toBeCloseTo(10.5);
    expect(adapter.estimateCostPence()).toBe(19);
    const job = await adapter.submit(clipRequest('o1'));
    expect(job.providerJobId).toMatch(/^sim_seedance_/);
    expect((await adapter.poll(job.providerJobId)).state).toBe('running');
    advance(10_500);
    expect((await adapter.poll(job.providerJobId)).state).toBe('succeeded');
    expect((await adapter.poll(job.providerJobId)).state).toBe('failed'); // gone
    expect(adapter.stats).toMatchObject({ current: 0, peak: 1, submitted: 1 });
    expect(await adapter.healthCheck()).toEqual({ healthy: true });
  });

  it('answers 429 over the account cap and tracks peaks per organisation', async () => {
    const { p } = profile();
    const adapter = new SimulatedAdapter('seedance', ['text_to_video'], {
      latencySec: [1, 1],
      costPence: 1,
      respond: async () => ({ state: 'succeeded', output: { metadata: {} } }),
      profile: p,
    });
    const a = await adapter.submit(clipRequest('o1'));
    await adapter.submit(clipRequest('o2'));
    const err = await adapter.submit(clipRequest('o3')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ errorClass: 'rate_limited', retryable: true });
    await adapter.cancel(a.providerJobId);
    await adapter.cancel('unknown');
    expect(adapter.stats).toMatchObject({ current: 1, peak: 2, rateLimited: 1 });
    expect(adapter.stats.peakByOrganisation).toEqual({ o1: 1, o2: 1 });
  });

  it('injects background 429s and failures on flaky providers', async () => {
    const { p, advance } = profile({ rateLimitedRatio: 1 });
    const flaky = new SimulatedAdapter('veo', ['text_to_video'], {
      latencySec: [1, 1],
      costPence: 1,
      respond: async () => ({ state: 'succeeded', output: { metadata: {} } }),
      profile: p,
      flaky: true,
    });
    await expect(flaky.submit(clipRequest('o'))).rejects.toMatchObject({
      errorClass: 'rate_limited',
    });
    const failing = new SimulatedAdapter('veo', ['text_to_video'], {
      latencySec: [1, 1],
      costPence: 1,
      respond: async () => ({ state: 'succeeded', output: { metadata: {} } }),
      profile: { ...p, rateLimitedRatio: 0, failRatio: 1 },
      flaky: true,
    });
    const job = await failing.submit(clipRequest('o'));
    advance(1_000);
    expect(await failing.poll(job.providerJobId)).toMatchObject({ state: 'failed' });
    expect(failing.stats.failed).toBe(1);
  });

  it('answers the text layers by their system prompt', () => {
    const ask = (system: string) =>
      simulatedText({ capability: 'text_generation', organisationId: 'o', system, prompt: '' });
    expect(JSON.stringify(ask('You are the ideation layer'))).toContain('actionable');
    // Every script differs (15.B6 asset reuse would otherwise serve clips from earlier videos).
    const first = JSON.stringify(ask('the script and storyboard layer'));
    expect(first).toContain('Golden loaf on a counter, take ');
    expect(JSON.stringify(ask('the script and storyboard layer'))).not.toBe(first);
    expect(variedScript('t').shots[5]).toMatchObject({
      sceneDescription: 'Hands holding a warm loaf, take t-5',
      voiceoverText: 'Subscribe today. (t)',
    });
    expect(variedScript('t').shots[6]?.voiceoverText).toBe('');
    expect(JSON.stringify(ask('a social-media slideshow writer'))).toContain('items');
    expect(JSON.stringify(ask('anything else'))).toContain('ALLOW');
    expect(() =>
      simulatedText({ capability: 'embedding', organisationId: 'o', input: [], dimensions: 1 }),
    ).toThrow();
    expect(SIM_SCRIPT.shots.reduce((n, s) => n + Number(s.durationSec), 0)).toBe(30);
    expect(simulatedEmbedding('bread')).toHaveLength(1536);
  });
});

describe('local storage and the simulated registry', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('stores objects on disk and serves them (with ranges) on 127.0.0.1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-load-test-'));
    dirs.push(root);
    const local = await createLocalStorage(root);
    try {
      const put = await local.storage.put({
        bucket: 'assets',
        key: 'orgs/o/a b.mp4',
        body: new Uint8Array([1, 2, 3, 4]),
        contentType: 'video/mp4',
      });
      expect(put.url.startsWith(local.baseUrl)).toBe(true);
      expect(await local.storage.size('assets', 'orgs/o/a b.mp4')).toBe(4);
      expect([...(await local.storage.readRange('assets', 'orgs/o/a b.mp4', 1, 2))]).toEqual([
        2, 3,
      ]);
      const res = await fetch(put.url, { headers: { range: 'bytes=1-2' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3]);
      expect((await fetch(put.url, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(`${local.baseUrl}/assets/missing`)).status).toBe(404);
      expect((await fetch(`${local.baseUrl}/assets/..%2F..%2Fetc`)).status).toBe(400);
      await local.storage.copy?.('assets', 'orgs/o/a b.mp4', 'copy.mp4');
      const streamed = await local.storage.putStream?.({
        bucket: 'assets',
        key: 's.bin',
        contentType: 'application/octet-stream',
        body: (async function* () {
          yield new Uint8Array([9]);
          yield new Uint8Array([8]);
        })(),
      } as Parameters<NonNullable<typeof local.storage.putStream>>[0]);
      expect(streamed?.bytes).toBe(2);
      expect(await local.storage.signedUrl('assets', 'copy.mp4')).toContain('/assets/copy.mp4');
      await local.storage.delete('assets', 'copy.mp4');
      expect(local.bytesWritten()).toBe(10);
      expect(contentTypeOf('x.PNG')).toBe('image/png');
      expect(contentTypeOf('x.bin')).toBe('application/octet-stream');
      expect(() => objectPath(root, 'assets', '../../x')).toThrow();

      const { p } = profile();
      const { registry, adapters } = createSimulatedRegistry({
        profile: p,
        media: {
          clipUrl: `${local.baseUrl}/samples/clip.mp4`,
          renderUrl: `${local.baseUrl}/samples/render.mp4`,
          voice: new Uint8Array([1]),
          music: new Uint8Array([2]),
          png: new Uint8Array([3]),
        },
        storage: local.storage,
        assetsBucket: 'assets',
      });
      expect(adapters.map((a) => a.providerId)).toEqual([
        'anthropic',
        'seedance',
        'kling',
        'veo',
        'elevenlabs',
        'elevenlabs-music',
        'assemblyai',
        'openai',
        'shotstack',
      ]);
      const tts = registry.getAdapter('elevenlabs');
      const job = await tts.submit({
        capability: 'tts',
        organisationId: 'o',
        text: 'hi',
        voiceId: 'v',
      });
      expect(job.providerJobId).toMatch(/^sim_/);
      const embedding = await registry
        .getAdapter('openai')
        .submit({ capability: 'embedding', organisationId: 'o', input: ['a'], dimensions: 1536 });
      expect(embedding.estimatedCostPence).toBe(4);
    } finally {
      await local.close();
    }
  });

  it('builds the sample media from FFmpeg test sources', () => {
    const commands = sampleMediaCommands('/tmp/x', 'ff');
    expect(commands).toHaveLength(5);
    expect(commands.every(([bin]) => bin === 'ff')).toBe(true);
    expect(commands[1]?.[1].join(' ')).toContain('1080x1920');
  });
});

describe('load-test report', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(distribution([2, 4])).toEqual({ count: 2, p50: 2, p95: 4, max: 4, mean: 3 });
    expect(failureClass('seedance/rate_limited: busy')).toBe('seedance/rate_limited');
    expect(failureClass(null)).toBe('unknown');
    expect(failureClass('x'.repeat(80))).toHaveLength(61);
  });

  it('summarises outcomes, throughput and fairness', () => {
    const o = (
      id: string,
      org: string,
      seconds: number | undefined,
      state = 'READY_FOR_REVIEW',
    ): ProjectOutcome => ({
      projectId: id,
      organisationId: org,
      startedAt: 0,
      finishedAt: seconds === undefined ? undefined : seconds * 1000,
      finalState: state,
      errorReason: state === 'FAILED' ? 'seedance/timeout: slow' : null,
      costPence: 140,
    });
    const s = summarise([
      o('1', 'heavy', 600),
      o('2', 'heavy', 1200),
      o('3', 'heavy', undefined, 'FAILED'),
      o('4', 'light-a', 300),
      o('5', 'light-b', 600),
    ]);
    expect(s).toMatchObject({ projects: 5, ready: 4, byState: { READY_FOR_REVIEW: 4, FAILED: 1 } });
    expect(s.timeToReadyMs.max).toBe(1_200_000);
    expect(s.throughputPerHour).toBeCloseTo(12);
    expect(s.lightOrganisationSpread).toBe(2);
    expect(s.failureClasses).toEqual({ 'seedance/timeout': 1 });
    const md = renderMarkdown({ title: 'burst', timeScale: 0.5, summary: s, extra: { Peak: 3 } });
    expect(md).toContain('### burst');
    expect(md).toContain('2400 s'); // 1200 s simulated at time scale 0.5
    expect(md).toContain('| Peak | 3 |');
  });
});

describe('provider wait note', () => {
  it('merges metadata.providerWait for the run, and skips work without a project', async () => {
    const executeRaw = vi.fn(async () => 1);
    const deps = { db: { $executeRaw: executeRaw }, now: () => Date.parse('2026-10-03T12:00:00Z') };
    expect(await noteProviderWait(deps as never, { runId: 'r' }, 1_000)).toBe(false);
    expect(await noteProviderWait(deps as never, { projectId: 'p', runId: 'r' }, 15_000)).toBe(
      true,
    );
    const values = (executeRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContain('p');
    expect(String(values[0])).toContain('"retryAt":"2026-10-03T12:00:15.000Z"');
  });
});

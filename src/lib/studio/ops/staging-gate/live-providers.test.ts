import { describe, expect, it } from 'vitest';
import { PLATFORMS } from '../../services/catalog';
import {
  estimateLines,
  formatPence,
  LIVE_PROVIDER_TESTS,
  liveSections,
  MANUAL_FOLLOW_UPS,
  missingEnv,
  postTargets,
  testPostOptions,
  type PlannedTest,
} from './live-providers';

const byId = (id: string) => LIVE_PROVIDER_TESTS.find((t) => t.id === id);

describe('LIVE_PROVIDER_TESTS', () => {
  it('covers every provider named in plan 14.8, with unique ids', () => {
    const ids = LIVE_PROVIDER_TESTS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'runway',
      'luma',
      'veo',
      'seedance',
      'heygen',
      'elevenlabs',
      'elevenlabs-music',
      'elevenlabs-voice',
      'shotstack',
      'assemblyai',
      'openai-image',
      'anthropic',
      'storyblocks-sfx',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('runs the existing GATE 2 scripts where one exists', () => {
    expect(byId('runway')).toMatchObject({ kind: 'script', npmScript: 'gate2:runway' });
    expect(byId('assemblyai')?.kind).toBe('adapter');
  });

  it('builds requests from env (mirroring the scripts for the estimate)', () => {
    const heygen = byId('heygen')?.request?.({
      HEYGEN_TEST_AUDIO_URL: 'https://x/a.mp3',
      HEYGEN_TEST_AUDIO_SEC: '12',
    });
    expect(heygen).toMatchObject({ capability: 'avatar_video', durationSec: 12 });
    const assemblyai = byId('assemblyai')?.request?.({
      LIVE_TEST_MEDIA_URL: 'https://x/v.mp4',
      LIVE_TEST_MEDIA_SEC: '30',
    });
    expect(assemblyai).toMatchObject({ capability: 'transcription', durationSec: 30 });
  });

  it('reports missing env', () => {
    const assemblyai = byId('assemblyai');
    expect(assemblyai && missingEnv(assemblyai, { ASSEMBLYAI_API_KEY: 'k' })).toEqual([
      'LIVE_TEST_MEDIA_URL',
    ]);
  });

  it('20.21: has no Hive or other content-safety test (no provider is used)', () => {
    expect(LIVE_PROVIDER_TESTS.filter((t) => /hive/i.test(`${t.id} ${t.providerId}`))).toEqual([]);
    expect(MANUAL_FOLLOW_UPS.join(' ')).not.toMatch(/hive/i);
  });

  it('asks for the storage settings of STORAGE_PROVIDER (S3 or R2) for storage tests', () => {
    const image = byId('openai-image');
    const base = { OPENAI_API_KEY: 'k', S3_BUCKET_ASSETS: 'assets' };
    expect(image && missingEnv(image, base)).toEqual(['AWS_REGION']);
    expect(
      image && missingEnv(image, { ...base, STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'a' }),
    ).toEqual(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
  });
});

describe('posts', () => {
  it('has one env pair per publishing platform', () => {
    const targets = postTargets();
    expect(targets.map((t) => t.platform)).toEqual([...PLATFORMS]);
    expect(targets[0]).toEqual({
      platform: 'tiktok',
      tokenEnv: 'LIVE_TIKTOK_ACCESS_TOKEN',
      accountEnv: 'LIVE_TIKTOK_ACCOUNT_ID',
    });
  });

  it('keeps test posts private where the platform allows it', () => {
    expect(testPostOptions('tiktok')).toEqual({ privacyLevel: 'SELF_ONLY' });
    expect(testPostOptions('youtube_short')).toEqual({ privacyStatus: 'private' });
    expect(testPostOptions('x')).toEqual({});
  });
});

describe('estimateLines', () => {
  it('totals runnable tests and lists skips and manual removals', () => {
    const tests: PlannedTest[] = [
      { test: byId('runway') as PlannedTest['test'], estimatePence: 47 },
      { test: byId('luma') as PlannedTest['test'], estimatePence: 120 },
      {
        test: byId('heygen') as PlannedTest['test'],
        skipReason: 'missing HEYGEN_API_KEY',
        estimatePence: null,
      },
      { test: byId('assemblyai') as PlannedTest['test'], estimatePence: null },
    ];
    const [tiktok, youtube] = postTargets();
    const text = estimateLines(tests, [
      { target: tiktok as never, takedownSupported: false },
      {
        target: youtube as never,
        skipReason: 'missing LIVE_YOUTUBE_ACCESS_TOKEN',
        takedownSupported: true,
      },
    ]).join('\n');
    expect(text).toContain('Total: ~£1.67 plus assemblyai (no estimate)');
    expect(text).toContain('heygen: SKIPPED (missing HEYGEN_API_KEY)');
    expect(text).toContain('tiktok: post + MANUAL removal');
    expect(formatPence(5)).toBe('£0.05');
  });
});

describe('liveSections', () => {
  it('passes only when everything ran and succeeded', () => {
    const ok = { id: 'a', ok: true, detail: 'fine' };
    expect(liveSections({ tests: [ok], posts: [ok], estimate: [] }).verdict).toBe('PASS');
    expect(
      liveSections({
        tests: [ok, { id: 'b', ok: null, detail: 'skipped' }],
        posts: [ok],
        estimate: [],
      }).verdict,
    ).toBe('INCOMPLETE');
    const failed = liveSections({
      tests: [ok],
      posts: [{ id: 'x', ok: false, detail: '401' }],
      estimate: ['est'],
    });
    expect(failed.verdict).toBe('FAIL');
    expect(failed.sections.map((s) => s.title)).toContain('Manual follow-ups');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../../../../test/helpers/fake-fetch';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ProviderError, ValidationError } from '../../errors';
import { createProviderRegistry } from '../providers/registry';
import { StubAdapter } from '../providers/test-adapter';
import { buildShotstackEdit, escapeHtml, outputDimensions, totalDuration } from './edl';
import { buildIdeationPrompt, parseIdeationResult } from './ideation';
import {
  parseBlackdetect,
  parseFfprobe,
  parseIntegratedLoudness,
  parseSceneChanges,
} from './media-probe';
import { copyUrlToStorage } from './persist';
import { ALLOWED_TRANSITIONS, canTransition, currentRunId, projectMetadata } from './project-state';
import { jsonOutput } from './provider-run';
import {
  evaluateContentSafety,
  evaluateQuality,
  hasContentSafetyBlock,
  qualityPassed,
  type QualityInputs,
} from './quality-checks';
import { blocksGeneration, buildScriptSafetyPrompt, parseScriptSafety } from './script-safety';
import {
  availableTreatments,
  buildScriptPrompt,
  fitDurations,
  normaliseScript,
  parseTargetFormats,
  scriptSchema,
  type PlannedShot,
} from './scripting';

const brief = {
  actionable: true,
  directionOptions: [],
  hook: 'h',
  keyMessage: 'k',
  targetAudience: 'a',
  tone: 't',
  callToAction: '',
  keywords: ['x'],
  restrictedTopicsMentioned: [],
};

describe('project state machine', () => {
  it('allows only forward pipeline moves and terminal ARCHIVED', () => {
    expect(canTransition('QUEUED', 'PLANNING')).toBe(true);
    expect(canTransition('RENDERING', 'PLANNING')).toBe(false);
    expect(canTransition('QUALITY_FAILED', 'APPROVED')).toBe(true); // force-approve
    expect(ALLOWED_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it('reads metadata and run ids defensively', () => {
    expect(projectMetadata(null)).toEqual({});
    expect(projectMetadata([1] as never)).toEqual({});
    expect(currentRunId({ metadata: { runId: 'r1' } })).toBe('r1');
  });
});

describe('ideation', () => {
  it('builds a prompt with brand context and restricted topics', () => {
    const prompt = buildIdeationPrompt({
      rawInput: '  launch video  ',
      businessName: 'Bakery',
      targetPlatforms: ['tiktok'],
      brand: { toneKeywords: ['warm'], audienceProfile: 'locals', restrictedTopics: ['politics'] },
    });
    expect(prompt).toContain('Brand tone: warm');
    expect(prompt).toContain('Restricted topics (never mention): politics');
    expect(prompt).toContain('"""\nlaunch video\n"""');
    expect(buildIdeationPrompt({ rawInput: 'x', targetPlatforms: [] })).toContain(
      'Business: not specified',
    );
  });

  it('rejects invalid model output as retryable', () => {
    expect(parseIdeationResult(brief)).toEqual(brief);
    expect(() => parseIdeationResult({ hook: 1 })).toThrow(ProviderError);
  });
});

describe('scripting', () => {
  const treatments = ['AI_CLIP', 'TEXT_CARD'] as const;
  const shot = (durationSec: number, visualTreatment: 'AI_CLIP' | 'TEXT_CARD' = 'AI_CLIP') => ({
    durationSec,
    visualTreatment,
    sceneDescription: 'scene',
    cameraDirection: '',
    voiceoverText: 'vo',
    onScreenText: '',
    transitionOut: 'cut',
  });

  it('parses target formats from video_projects.targetFormats', () => {
    expect(parseTargetFormats([{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }])).toEqual(
      [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
    );
    expect(() => parseTargetFormats([])).toThrow(ValidationError);
    expect(() => parseTargetFormats([{ platform: 'x', aspectRatio: '3:2', duration: 5 }])).toThrow(
      ValidationError,
    );
  });

  it('offers only treatments with configured providers, plus TEXT_CARD', () => {
    expect(availableTreatments(createProviderRegistry([]))).toEqual(['TEXT_CARD']);
    const registry = createProviderRegistry([
      new StubAdapter('runway', ['text_to_video']),
      new StubAdapter('openai', ['text_to_image']),
    ]);
    expect(availableTreatments(registry)).toEqual(['AI_CLIP', 'IMAGE_STILL', 'TEXT_CARD']);
  });

  it('restricts the schema enum to available treatments', () => {
    const schema = scriptSchema([...treatments]);
    expect(schema.properties.shots.items.properties.visualTreatment.enum).toEqual([
      'AI_CLIP',
      'TEXT_CARD',
    ]);
  });

  it('builds a prompt from the brief and format', () => {
    const prompt = buildScriptPrompt({
      brief,
      format: { platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 },
      treatments: [...treatments],
      restrictedTopics: ['politics'],
    });
    expect(prompt).toContain('Target duration: 30 seconds');
    expect(prompt).toContain('Never mention: politics');
    expect(prompt).toContain('No call to action.');
  });

  it('normalises shots: clamps to provider limits and sums to the target', () => {
    const plan = normaliseScript(
      { fullText: ' vo ', shots: [shot(1), shot(20), shot(3, 'TEXT_CARD')] },
      [...treatments],
      15,
    );
    expect(plan.fullText).toBe('vo');
    const total = plan.shots.reduce((s, x) => s + x.durationSec, 0);
    expect(total).toBeCloseTo(15, 5);
    for (const s of plan.shots) {
      expect(s.durationSec).toBeGreaterThanOrEqual(s.visualTreatment === 'AI_CLIP' ? 2 : 1);
      expect(s.durationSec).toBeLessThanOrEqual(10);
    }
    expect(plan.shots[0]?.cameraDirection).toBeNull();
  });

  it('rejects unavailable treatments and malformed output as retryable', () => {
    expect(() =>
      normaliseScript({ fullText: 'x', shots: [shot(5, 'AI_CLIP')] }, ['TEXT_CARD'], 5),
    ).toThrow(/unavailable treatment/);
    expect(() => normaliseScript({ fullText: 'x', shots: [] }, [...treatments], 5)).toThrow(
      ProviderError,
    );
  });

  it('fitDurations keeps a feasible total even when bounds bind', () => {
    const shots: PlannedShot[] = [2, 2].map((d, i) => ({
      sortOrder: i,
      durationSec: d,
      visualTreatment: 'AI_CLIP',
      sceneDescription: 's',
      cameraDirection: null,
      voiceoverText: null,
      onScreenText: null,
      transitionOut: 'cut',
    }));
    // Target 30s is impossible with two ≤10s clips: best effort is 20s, never beyond bounds.
    expect(fitDurations(shots, 30).map((s) => s.durationSec)).toEqual([10, 10]);
  });
});

describe('script safety', () => {
  it('builds a prompt covering every script and on-screen text', () => {
    const prompt = buildScriptSafetyPrompt([
      { platform: 'tiktok', fullText: 'hello', onScreenText: ['A', 'B'] },
      { platform: 'youtube', fullText: 'bye', onScreenText: [] },
    ]);
    expect(prompt).toContain('Script 1 (tiktok):\nhello\nOn-screen text: A | B');
    expect(prompt).toContain('Script 2 (youtube):\nbye');
  });

  it('blocks on BLOCK and REVIEW (fail closed), not on WARN/ALLOW', () => {
    const r = (verdict: string) => parseScriptSafety({ verdict, categories: [], reason: '' });
    expect(blocksGeneration(r('BLOCK'))).toBe(true);
    expect(blocksGeneration(r('REVIEW'))).toBe(true);
    expect(blocksGeneration(r('WARN'))).toBe(false);
    expect(blocksGeneration(r('ALLOW'))).toBe(false);
    expect(() => parseScriptSafety({ verdict: 'MAYBE' })).toThrow(ProviderError);
  });
});

describe('Shotstack edit list', () => {
  it('maps aspect ratios to 1080-class output sizes', () => {
    expect(outputDimensions('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(outputDimensions('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(outputDimensions('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(outputDimensions('4:5')).toEqual({ width: 1080, height: 1350 });
  });

  it('sequences clips, captions, narration and music', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '9:16',
      musicSrc: 'https://m/music.mp3',
      shots: [
        {
          durationSec: 4,
          visualTreatment: 'AI_CLIP',
          visualSrc: 'https://s/1.mp4',
          visualKind: 'video',
          voiceSrc: 'https://s/v1.mp3',
          onScreenText: 'Hi <you>',
          transitionOut: 'fade',
        },
        {
          durationSec: 3,
          visualTreatment: 'IMAGE_STILL',
          visualSrc: 'https://s/2.png',
          visualKind: 'image',
        },
        { durationSec: 2, visualTreatment: 'TEXT_CARD', cardText: 'Subscribe' },
      ],
    }) as {
      timeline: { tracks: Array<{ clips: Array<Record<string, unknown>> }> };
      output: unknown;
    };
    const [captions, visual, voice, music] = edit.timeline.tracks;
    expect(visual?.clips.map((c) => [c.start, c.length])).toEqual([
      [0, 4],
      [4, 3],
      [7, 2],
    ]);
    expect(visual?.clips[0]).toMatchObject({
      asset: { type: 'video', volume: 0 },
      fit: 'cover',
      transition: { out: 'fade' },
    });
    expect(visual?.clips[1]).toMatchObject({ asset: { type: 'image' }, effect: 'zoomIn' });
    expect(visual?.clips[2]).toMatchObject({ asset: { type: 'html', html: '<p>Subscribe</p>' } });
    expect((captions?.clips[0]?.asset as { html: string }).html).toBe('<p>Hi &lt;you&gt;</p>');
    expect(voice?.clips).toHaveLength(1);
    expect(music?.clips[0]).toMatchObject({ start: 0, length: 9, asset: { volume: 0.2 } });
    expect(edit.output).toEqual({
      format: 'mp4',
      resolution: '1080',
      aspectRatio: '9:16',
      fps: 30,
    });
  });

  it('omits empty tracks and rejects unsafe brand styling', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '1:1',
      shots: [{ durationSec: 2, visualTreatment: 'TEXT_CARD', cardText: 'x' }],
      brand: { backgroundColour: 'red;} body{', textColour: '#00ff00', fontFamily: "Comic'; x" },
    }) as {
      timeline: { background: string; tracks: Array<{ clips: Array<{ asset: { css: string } }> }> };
    };
    expect(edit.timeline.tracks).toHaveLength(1);
    expect(edit.timeline.background).toBe('#000000');
    const css = edit.timeline.tracks[0]?.clips[0]?.asset.css ?? '';
    expect(css).toContain('#00ff00');
    expect(css).toContain("'Arial'");
  });

  it('escapes HTML and totals durations', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(
      totalDuration([
        { durationSec: 1.1, visualTreatment: 'TEXT_CARD' },
        { durationSec: 2.2, visualTreatment: 'TEXT_CARD' },
      ]),
    ).toBe(3.3);
  });
});

describe('media probe parsers', () => {
  const ffprobe = JSON.stringify({
    format: { duration: '15.033', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', bit_rate: '4521000' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        width: 1080,
        height: 1920,
        avg_frame_rate: '30000/1001',
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  });

  it('parses ffprobe JSON', () => {
    expect(parseFfprobe(ffprobe)).toEqual({
      durationSec: 15.033,
      width: 1080,
      height: 1920,
      fps: 29.97,
      videoCodec: 'h264',
      videoProfile: 'High',
      audioCodec: 'aac',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitRateKbps: 4521,
    });
    expect(() => parseFfprobe('nope')).toThrow(ValidationError);
    expect(() => parseFfprobe(JSON.stringify({ format: {}, streams: [] }))).toThrow(
      /no video stream/,
    );
  });

  it('parses blackdetect and ebur128 output', () => {
    const stderr =
      '[blackdetect @ 0x1] black_start:0 black_end:0.6 black_duration:0.6\n[blackdetect @ 0x1] black_start:10.2 black_end:10.4 black_duration:0.2\n';
    expect(parseBlackdetect(stderr)).toEqual([
      { startSec: 0, endSec: 0.6, durationSec: 0.6 },
      { startSec: 10.2, endSec: 10.4, durationSec: 0.2 },
    ]);
    const summary =
      '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.3 LUFS\n    Threshold: -24.4 LUFS\n';
    expect(parseIntegratedLoudness(summary)).toBe(-14.3);
    expect(parseIntegratedLoudness('Integrated loudness:\n I: -inf LUFS')).toBeNull();
    expect(parseIntegratedLoudness('no summary')).toBeNull();
  });

  it('parses scene-change timestamps only from showinfo lines, dedupes, excludes 0, and sorts', () => {
    const stderr = [
      '[Parsed_select_0 @ 0x1] some other filter line pts_time:99.000000',
      '[Parsed_showinfo_1 @ 0x1] n:1 pts_time:0.000000 pos:0',
      '[Parsed_showinfo_1 @ 0x1] n:2 pts_time:4.500000 pos:1',
      '[Parsed_showinfo_1 @ 0x1] n:3 pts_time:2.100000 pos:2',
      '[Parsed_showinfo_1 @ 0x1] n:4 pts_time:2.100000 pos:2', // duplicate
    ].join('\r\n');
    expect(parseSceneChanges(stderr)).toEqual([2.1, 4.5]);
  });

  it('returns an empty array when there are no showinfo lines', () => {
    expect(parseSceneChanges('nothing relevant here')).toEqual([]);
  });
});

describe('quality checks (spec 13.1)', () => {
  const base: QualityInputs = {
    target: { durationSec: 15, aspectRatio: '9:16' },
    probe: {
      durationSec: 15.5,
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      videoProfile: 'High',
      audioCodec: 'aac',
      formatName: 'mov,mp4',
      bitRateKbps: 4000,
    },
    blackIntervals: [],
    loudnessLufs: -14,
    contentSafety: {
      scan: { framesAnalysed: 15, maxScores: { general_nsfw: 0.01 }, flaggedFrames: [] },
    },
  };
  const status = (checks: ReturnType<typeof evaluateQuality>, code: string) =>
    checks.find((c) => c.code === code)?.status;

  it('passes a clean render and records not-yet-built checks as not_run', () => {
    const checks = evaluateQuality(base);
    expect(qualityPassed(checks)).toBe(true);
    expect(checks.filter((c) => c.status === 'not_run').map((c) => c.code)).toEqual([
      'audio_sync',
      'watermark',
      'caption_sync',
      'brand_kit',
    ]);
  });

  it.each([
    ['duration_match', { probe: { ...base.probe, durationSec: 17.5 } }],
    ['black_frames', { blackIntervals: [{ startSec: 1, endSec: 1.6, durationSec: 0.6 }] }],
    ['audio_present', { loudnessLufs: -25 }],
    ['audio_present', { loudnessLufs: null }],
    ['aspect_ratio', { probe: { ...base.probe, width: 1920, height: 1080 } }],
    ['codec', { probe: { ...base.probe, videoCodec: 'hevc' } }],
  ] as const)('fails %s', (code, patch) => {
    const checks = evaluateQuality({ ...base, ...patch } as QualityInputs);
    expect(status(checks, code)).toBe('failed');
    expect(qualityPassed(checks)).toBe(false);
    expect(hasContentSafetyBlock(checks)).toBe(false);
  });

  it('treats content-safety BLOCK classes as block and REVIEW classes as force-approvable', () => {
    const blocked = evaluateContentSafety({
      scan: { framesAnalysed: 1, maxScores: { yes_nazi: 0.95 }, flaggedFrames: [] },
    });
    expect(blocked).toMatchObject({ status: 'failed', severity: 'block' });
    const review = evaluateContentSafety({
      scan: { framesAnalysed: 1, maxScores: { gun_in_hand: 0.9 }, flaggedFrames: [] },
    });
    expect(review).toMatchObject({ status: 'failed', severity: 'error' });
  });

  it('fails closed when content safety could not run', () => {
    const checks = evaluateQuality({ ...base, contentSafety: { unavailable: 'no provider' } });
    expect(hasContentSafetyBlock(checks)).toBe(true);
  });
});

describe('copyUrlToStorage', () => {
  const input = {
    url: 'https://p/out.mp4',
    bucket: 'b',
    key: 'k.mp4',
    fallbackContentType: 'video/mp4',
    providerId: 'runway',
  };

  it('downloads and stores the bytes', async () => {
    const { storage, objects } = memoryStorage();
    const { fetch } = fakeFetch(
      new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'video/mp4; codecs=x' } }),
    );
    const copied = await copyUrlToStorage(storage, input, fetch);
    expect(copied).toMatchObject({ bytes: 2, contentType: 'video/mp4', bucket: 'b', key: 'k.mp4' });
    expect(objects.get('b/k.mp4')?.body).toEqual(new Uint8Array([1, 2]));
  });

  it.each([
    [new Response(null, { status: 403 }), 'result_expired'],
    [new Response(null, { status: 503 }), 'provider_unavailable'],
    [new Response(new Uint8Array()), 'unknown'],
    [new Response('x', { headers: { 'content-length': String(2e9) } }), 'invalid_request'],
    [new TypeError('reset'), 'provider_unavailable'],
  ])('classifies download failures (%#)', async (reply, errorClass) => {
    const { storage } = memoryStorage();
    const { fetch } = fakeFetch(reply);
    await expect(copyUrlToStorage(storage, input, fetch)).rejects.toMatchObject({ errorClass });
  });
});

describe('jsonOutput', () => {
  it('returns structured JSON or fails retryably', () => {
    expect(jsonOutput({ metadata: { json: { a: 1 } } })).toEqual({ a: 1 });
    expect(() => jsonOutput({ metadata: { text: 'x' } })).toThrow(ProviderError);
  });
});

void vi;

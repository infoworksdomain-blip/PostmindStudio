import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { MediaProbe } from './media-probe';
import {
  codecCompliant,
  masterArgs,
  masteringNeeded,
  masterStoredRender,
  measureFilter,
  normaliseFilter,
  parseLoudnormJson,
  planMastering,
  type RenderMastering,
} from './mastering';

const probe = (over: Partial<MediaProbe> = {}): MediaProbe => ({
  durationSec: 30,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  videoProfile: 'High',
  audioCodec: 'aac',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitRateKbps: 4500,
  ...over,
});

const measured = {
  inputI: -22.4,
  inputTp: -4.1,
  inputLra: 6.2,
  inputThresh: -32.7,
  targetOffset: 0.3,
};

// The block loudnorm prints at the end of pass 1 (print_format=json, ffmpeg-filters docs).
const PASS1_STDERR = [
  '[Parsed_loudnorm_0 @ 0x55]',
  '{',
  '\t"input_i" : "-22.40",',
  '\t"input_tp" : "-4.10",',
  '\t"input_lra" : "6.20",',
  '\t"input_thresh" : "-32.70",',
  '\t"output_i" : "-14.02",',
  '\t"normalization_type" : "dynamic",',
  '\t"target_offset" : "0.30"',
  '}',
].join('\n');

describe('planMastering', () => {
  it('skips a compliant render', () => {
    const plan = planMastering(probe(), -14);
    expect(plan).toEqual({ normaliseAudio: false, reencodeVideo: false, reasons: [] });
    expect(masteringNeeded(plan)).toBe(false);
  });

  it('normalises loudness outside the gate window and re-encodes non-H.264 / non-MP4', () => {
    expect(planMastering(probe(), -22.4).normaliseAudio).toBe(true);
    expect(planMastering(probe(), -8).normaliseAudio).toBe(true);
    const vp9 = planMastering(probe({ videoCodec: 'vp9', formatName: 'matroska,webm' }), -14);
    expect(vp9).toMatchObject({ normaliseAudio: false, reencodeVideo: true });
    expect(vp9.reasons[0]).toContain('vp9 in matroska,webm');
    expect(codecCompliant(probe({ formatName: 'matroska,webm' }))).toBe(false);
  });

  it('cannot normalise a render without audio', () => {
    expect(planMastering(probe({ audioCodec: null }), null).normaliseAudio).toBe(false);
  });

  it('leaves a silent track alone (ebur128 ≈ −70 LUFS; loudnorm would measure -inf)', () => {
    // Production 2026-10-06: a slideshow without a music bed failed composition in pass 1.
    expect(planMastering(probe(), -70).normaliseAudio).toBe(false);
    expect(masteringNeeded(planMastering(probe(), -70))).toBe(false);
    expect(planMastering(probe(), -59).normaliseAudio).toBe(true);
  });
});

describe('loudnorm helpers', () => {
  it('parses the pass-1 measurement', () => {
    expect(parseLoudnormJson(PASS1_STDERR)).toEqual(measured);
    expect(() => parseLoudnormJson('no json here')).toThrow('no measurement');
    expect(() => parseLoudnormJson('{ not json }')).toThrow('not valid JSON');
    expect(() => parseLoudnormJson('{"input_i":"x"}')).toThrow('input_i');
  });

  it('builds the two-pass filters at -14 LUFS / -1.5 dBTP / 11 LU', () => {
    expect(measureFilter()).toBe('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json');
    expect(normaliseFilter(measured)).toBe(
      'loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-22.4:measured_TP=-4.1:measured_LRA=6.2:measured_thresh=-32.7:offset=0.3:linear=true:print_format=summary',
    );
  });

  it('copies compliant video and re-encodes to H.264 Baseline otherwise', () => {
    const audioOnly = masterArgs(
      'in',
      { normaliseAudio: true, reencodeVideo: false, reasons: [] },
      measured,
      'out.mp4',
    );
    expect(audioOnly).toEqual(
      expect.arrayContaining(['-c:v', 'copy', '-ar', '48000', '-movflags', '+faststart']),
    );
    expect(audioOnly.join(' ')).toContain('linear=true');
    const video = masterArgs(
      'in',
      { normaliseAudio: false, reencodeVideo: true, reasons: [] },
      null,
      'out.mp4',
    );
    expect(video.join(' ')).toContain('-c:v libx264 -profile:v baseline');
    expect(video).not.toContain('-af');
  });
});

describe('masterStoredRender', () => {
  const stored = {
    bucket: 'renders',
    key: 'orgs/o/projects/p/providers/shotstack/a.mp4',
    url: 'https://s/a',
  };
  const setup = (over: { loudness?: number | null; mastering?: RenderMastering } = {}) => {
    const put = vi.fn(async (i: { bucket: string; key: string }) => ({
      ...i,
      url: `https://s/${i.key}`,
    }));
    const del = vi.fn(async () => undefined);
    const deps = {
      media: {
        integratedLoudness: vi.fn(async () => (over.loudness === undefined ? -14 : over.loudness)),
        probe: vi.fn(async () => probe({ durationSec: 30.1 })),
      } as never,
      mastering: over.mastering,
      storage: { put, delete: del } as never,
      logger: pino({ level: 'silent' }),
    };
    return { put, del, deps };
  };
  const input = (p: MediaProbe = probe()) => ({
    stored,
    probe: p,
    organisationId: 'o',
    projectId: 'p',
  });

  it('leaves a compliant render untouched', async () => {
    const { deps, put } = setup();
    const out = await masterStoredRender(deps, input());
    expect(out.stored).toBe(stored);
    expect(out.report).toEqual({
      applied: false,
      reasons: ['already compliant'],
      loudnessBeforeLufs: -14,
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('reports what it would fix when mastering is not configured', async () => {
    const { deps } = setup({ loudness: -25 });
    const out = await masterStoredRender(deps, input());
    expect(out.report.applied).toBe(false);
    expect(out.report.reasons.at(-1)).toContain('mastering not configured');
  });

  it('measures, masters, replaces the stored file and re-probes', async () => {
    const mastering: RenderMastering = {
      measure: vi.fn(async () => measured),
      master: vi.fn(async () => new Uint8Array([9, 9])),
    };
    const { deps, put, del } = setup({ loudness: -22.4, mastering });
    const out = await masterStoredRender(deps, input());
    expect(mastering.master).toHaveBeenCalledWith(
      stored.url,
      expect.objectContaining({ normaliseAudio: true, reencodeVideo: false }),
      measured,
    );
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'renders', contentType: 'video/mp4' }),
    );
    expect(out.stored.key).toMatch(/^orgs\/o\/projects\/p\/providers\/mastered\/.+\.mp4$/);
    expect(del).toHaveBeenCalledWith('renders', stored.key);
    expect(out.probe.durationSec).toBe(30.1);
    expect(out.report).toMatchObject({
      applied: true,
      loudnessBeforeLufs: -22.4,
      measuredLufs: -22.4,
    });
  });

  it('re-encodes without a loudness pass when only the codec is wrong', async () => {
    const mastering: RenderMastering = {
      measure: vi.fn(async () => measured),
      master: vi.fn(async () => new Uint8Array([1])),
    };
    const { deps } = setup({ mastering });
    const out = await masterStoredRender(deps, input(probe({ videoCodec: 'hevc' })));
    expect(mastering.measure).not.toHaveBeenCalled();
    expect(out.report.applied).toBe(true);
    expect(out.report).not.toHaveProperty('measuredLufs');
  });

  it('skips the loudness read when there is no audio stream', async () => {
    const { deps } = setup();
    const out = await masterStoredRender(deps, input(probe({ audioCodec: null })));
    expect(out.report.loudnessBeforeLufs).toBeNull();
  });
});

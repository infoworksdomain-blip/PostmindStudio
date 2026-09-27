import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ConfigurationError, UpstreamServiceError } from '../../errors';
import { DEFAULT_STYLE } from './params';
import type { FrameSize, OverlayRow } from './shotstack';

vi.mock('../pipeline/media-probe', () => ({ run: vi.fn() }));

import { run } from '../pipeline/media-probe';
import {
  buildPreRenderArgs,
  counterTarget,
  ffColour,
  karaokeSteps,
  preRenderKey,
  preRenderOverlay,
  preRenderTexts,
  type PreRenderDeps,
  type PreRenderFiles,
} from './prerender';

const mockedRun = vi.mocked(run);

const FRAME: FrameSize = { width: 1080, height: 1920 };

function overlayRow(overrides: Partial<OverlayRow> = {}): OverlayRow {
  return {
    ...DEFAULT_STYLE,
    id: 'ov-1',
    text: 'Hello world',
    startAtSec: 0,
    endAtSec: 3,
    ...overrides,
  };
}

describe('ffColour', () => {
  it('converts a #RRGGBBAA colour to ffmpeg 0xRRGGBB@alpha syntax', () => {
    expect(ffColour('#FF000080')).toBe('0xff0000@0.502');
  });

  it('defaults to full opacity for a #RRGGBB colour', () => {
    expect(ffColour('#000000')).toBe('0x000000@1');
  });
});

describe('counterTarget', () => {
  it('uses the first number found in the text when no effect is set', () => {
    expect(counterTarget(overlayRow({ text: '42%', effect: null }))).toEqual({
      from: 0,
      to: 42,
      suffix: '%',
    });
  });

  it('returns to=0 and an empty suffix when the text has no number', () => {
    expect(counterTarget(overlayRow({ text: 'no digits here', effect: null }))).toEqual({
      from: 0,
      to: 0,
      suffix: '',
    });
  });

  it('prefers effect.counterTo and effect.counterFrom over the parsed number', () => {
    expect(
      counterTarget(
        overlayRow({ text: 'Grew 12 today', effect: { counterTo: 500, counterFrom: 10 } }),
      ),
    ).toEqual({ from: 10, to: 500, suffix: ' today' });
  });

  it('takes the suffix from right after the matched number', () => {
    expect(counterTarget(overlayRow({ text: '99x', effect: null }))).toEqual({
      from: 0,
      to: 99,
      suffix: 'x',
    });
  });
});

describe('karaokeSteps', () => {
  it('returns one step per word with an accumulating prefix', () => {
    expect(karaokeSteps('a b c', 3)).toEqual([
      { prefix: 'a', at: 0 },
      { prefix: 'a b', at: 1 },
      { prefix: 'a b c', at: 2 },
    ]);
  });

  it('returns an empty array for empty text', () => {
    expect(karaokeSteps('', 3)).toEqual([]);
  });

  it('collapses repeated whitespace between words', () => {
    expect(karaokeSteps('a   b', 2)).toEqual([
      { prefix: 'a', at: 0 },
      { prefix: 'a b', at: 1 },
    ]);
  });
});

describe('preRenderTexts', () => {
  it('produces a single %{eif} counter expression with an escaped % suffix', () => {
    const overlay = overlayRow({
      animationIn: 'counter',
      animationInMs: 2000,
      startAtSec: 0,
      endAtSec: 5,
      text: '0%',
      effect: { counterFrom: 10, counterTo: 90 },
    });
    const texts = preRenderTexts(overlay);
    expect(texts).toEqual(['%{eif:trunc(10+(80)*min(1,t/2.000)):d}\\%']);
  });

  it('falls back to the default counter duration when animationInMs is 0', () => {
    const overlay = overlayRow({
      animationIn: 'counter',
      animationInMs: 0,
      startAtSec: 0,
      endAtSec: 5,
      text: '0 items',
      effect: null,
    });
    const [text] = preRenderTexts(overlay);
    expect(text).toContain('t/1.500');
  });

  it('produces the full text followed by karaoke prefixes for karaokeHighlight', () => {
    const overlay = overlayRow({
      animationIn: 'karaokeHighlight',
      startAtSec: 0,
      endAtSec: 2,
      text: 'a b',
    });
    expect(preRenderTexts(overlay)).toEqual(['a b', 'a', 'a b']);
  });

  it('returns the plain text for animations that need no expansion', () => {
    const overlay = overlayRow({ animationIn: 'glitch', text: 'Boom' });
    expect(preRenderTexts(overlay)).toEqual(['Boom']);
  });
});

describe('buildPreRenderArgs', () => {
  it('builds a transparent lavfi colour source sized and timed to the overlay', () => {
    const overlay = overlayRow({ startAtSec: 1, endAtSec: 3.5, animationIn: 'fadeIn' });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    expect(args).toContain('lavfi');
    const inputIndex = args.indexOf('-i') + 1;
    expect(args[inputIndex]).toBe('color=c=black@0.0:s=1080x1920:r=30:d=2.500,format=rgba');
  });

  it('encodes with prores_ks 4444 and yuva444p10le pixel format', () => {
    const overlay = overlayRow();
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    expect(args).toEqual(
      expect.arrayContaining([
        '-c:v',
        'prores_ks',
        '-profile:v',
        '4444',
        '-pix_fmt',
        'yuva444p10le',
      ]),
    );
  });

  it('uses textfile with expansion=none for a plain text overlay', () => {
    const overlay = overlayRow({ animationIn: 'fadeIn' });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf).toContain("textfile='t0.txt'");
    expect(vf).toContain("expansion='none'");
  });

  it('uses expansion=normal for a counter overlay', () => {
    const overlay = overlayRow({ animationIn: 'counter' });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf).toContain("expansion='normal'");
  });

  it('builds 3 drawtext layers for a glitch overlay', () => {
    const overlay = overlayRow({ animationIn: 'glitch' });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf.split('drawtext=').length - 1).toBe(3);
  });

  it('builds a base layer plus one enable-gated layer per word for karaoke', () => {
    const overlay = overlayRow({ animationIn: 'karaokeHighlight', text: 'a b c' });
    const files: PreRenderFiles = {
      font: 'font.ttf',
      texts: ['full.txt', 'w0.txt', 'w1.txt', 'w2.txt'],
    };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf.split('drawtext=').length - 1).toBe(4);
    expect(vf.split('between(t,').length - 1).toBe(3);
  });

  it('includes borderw/bordercolor when a stroke is set', () => {
    const overlay = overlayRow({ strokeColor: '#000000', strokeWidthPx: 3 });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf).toContain('borderw=3');
    expect(vf).toContain('bordercolor=');
  });

  it('omits borderw/bordercolor when no stroke is set', () => {
    const overlay = overlayRow({ strokeColor: null, strokeWidthPx: null });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf).not.toContain('borderw');
  });

  it('never puts the user-supplied text directly into the argv array', () => {
    const overlay = overlayRow({ text: 'SECRET-USER-TEXT', animationIn: 'fadeIn' });
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    expect(args.join('|')).not.toContain('SECRET-USER-TEXT');
  });

  it('ends the argv array with the output path', () => {
    const overlay = overlayRow();
    const files: PreRenderFiles = { font: 'font.ttf', texts: ['t0.txt'] };
    const args = buildPreRenderArgs(overlay, FRAME, files, 'out.mov');
    expect(args[args.length - 1]).toBe('out.mov');
  });
});

describe('preRenderKey', () => {
  it('is deterministic for the same overlay content and frame', () => {
    const overlay = overlayRow();
    expect(preRenderKey('org-1', overlay, FRAME)).toBe(preRenderKey('org-1', overlay, FRAME));
  });

  it('is independent of the overlay id', () => {
    const a = overlayRow({ id: 'ov-a' });
    const b = overlayRow({ id: 'ov-b' });
    expect(preRenderKey('org-1', a, FRAME)).toBe(preRenderKey('org-1', b, FRAME));
  });

  it('changes when overlay content changes', () => {
    const a = overlayRow({ text: 'Hello' });
    const b = overlayRow({ text: 'Goodbye' });
    expect(preRenderKey('org-1', a, FRAME)).not.toBe(preRenderKey('org-1', b, FRAME));
  });

  it('changes when the frame changes', () => {
    const overlay = overlayRow();
    expect(preRenderKey('org-1', overlay, FRAME)).not.toBe(
      preRenderKey('org-1', overlay, { width: 720, height: 1280 }),
    );
  });
});

describe('preRenderOverlay', () => {
  const overlay = overlayRow({ animationIn: 'glitch' });

  function baseDeps(overrides: Partial<PreRenderDeps> = {}): PreRenderDeps {
    const { storage } = memoryStorage();
    return {
      storage,
      bucket: 'studio-renders',
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fontsBaseUrl: 'https://fonts.example.com',
      ...overrides,
    };
  }

  it('short-circuits and returns a signed URL when the render is already cached', async () => {
    const { storage } = memoryStorage();
    const key = preRenderKey('org-1', overlay, FRAME);
    await storage.put({
      bucket: 'studio-renders',
      key,
      body: new Uint8Array([1]),
      contentType: 'video/quicktime',
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not be called for a cached render');
    });
    const deps = baseDeps({ storage, fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = await preRenderOverlay(deps, 'org-1', overlay, FRAME);
    expect(url).toBe(`https://signed.example/studio-renders/${key}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws ConfigurationError when fontsBaseUrl is missing', async () => {
    const deps = baseDeps({ fontsBaseUrl: undefined });
    await expect(preRenderOverlay(deps, 'org-1', overlay, FRAME)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('throws UpstreamServiceError when the font download fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false }) as Response);
    const deps = baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(preRenderOverlay(deps, 'org-1', overlay, FRAME)).rejects.toBeInstanceOf(
      UpstreamServiceError,
    );
  });

  it('throws UpstreamServiceError when ffmpeg exits non-zero', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Response,
    );
    mockedRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'ffmpeg exploded' });
    const deps = baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(preRenderOverlay(deps, 'org-1', overlay, FRAME)).rejects.toBeInstanceOf(
      UpstreamServiceError,
    );
  });

  it('uploads the rendered file as out.mov with content-type video/quicktime on success', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Response,
    );
    mockedRun.mockImplementationOnce(async (_bin, _args, _timeout, cwd) => {
      await writeFile(join(cwd as string, 'out.mov'), new Uint8Array([9, 9, 9]));
      return { code: 0, stdout: '', stderr: '' };
    });
    const { storage, objects } = memoryStorage();
    const deps = baseDeps({ storage, fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = await preRenderOverlay(deps, 'org-1', overlay, FRAME);
    const key = preRenderKey('org-1', overlay, FRAME);
    expect(url).toBe(`https://signed.example/studio-renders/${key}`);
    const stored = objects.get(`studio-renders/${key}`);
    expect(stored?.contentType).toBe('video/quicktime');
    expect(stored?.body).toEqual(new Uint8Array([9, 9, 9]));
  });
});

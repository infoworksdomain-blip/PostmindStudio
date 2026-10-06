import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wallOfTextEdit } from '../../../../../test/helpers/local-render-fixtures';
import { ConfigurationError, NotImplementedError, UpstreamServiceError } from '../../../errors';
import type { RunResult } from '../../pipeline/media-probe';
import { localRenderEnabled } from './config';
import { createLocalRenderer, LOCAL_RENDERER_ID } from './renderer';

const runMock = vi.hoisted(() =>
  vi.fn<(binary: string, args: string[], timeoutMs: number, cwd?: string) => Promise<RunResult>>(),
);
vi.mock('../../pipeline/media-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pipeline/media-probe')>()),
  run: runMock,
}));

const LOUDNORM_JSON = `[Parsed_loudnorm_0 @ 0x1]\n{\n "input_i" : "-21.30",\n "input_tp" : "-6.10",\n "input_lra" : "2.40",\n "input_thresh" : "-31.50",\n "output_i" : "-14.0",\n "target_offset" : "0.20"\n}`;

const fetchImpl = vi.fn(
  async (url: string | URL | Request) =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': String(url).endsWith('.mp4') ? 'video/mp4' : 'audio/mpeg' },
    }),
) as unknown as typeof fetch;

/** ffmpeg stand-in: the loudness pass prints `loudness`, the render writes the output file. */
function fakeFfmpeg(loudness = LOUDNORM_JSON, renderCode = 0) {
  const dirs: string[] = [];
  runMock.mockImplementation(async (_bin, args, _timeout, cwd) => {
    if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 6.1', stderr: '' };
    if (cwd) dirs.push(cwd);
    if (args.includes('null')) return { code: 0, stdout: '', stderr: loudness };
    if (renderCode === 0 && cwd)
      await writeFile(path.join(cwd, args.at(-1) as string), 'mp4-bytes');
    return { code: renderCode, stdout: '', stderr: 'Error: something broke' };
  });
  return dirs;
}

beforeEach(() => {
  runMock.mockReset();
});

describe('createLocalRenderer', () => {
  it('measures the music, renders with one linear gain and cleans its temp directory', async () => {
    const dirs = fakeFfmpeg();
    let t = 1_000;
    const renderer = createLocalRenderer({ ffmpegPath: 'ffmpeg-test', now: () => (t += 500) });
    const out = await renderer.render(wallOfTextEdit(), { fetch: fetchImpl });
    expect(renderer.providerId).toBe(LOCAL_RENDERER_ID);
    expect(new TextDecoder().decode(out.bytes)).toBe('mp4-bytes');
    expect(out.measuredLufs).toBe(-21.3);
    expect(out.renderMs).toBe(500);
    const [measure, render] = runMock.mock.calls;
    expect(measure?.[0]).toBe('ffmpeg-test');
    expect(measure?.[1].join(' ')).toContain('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json');
    expect(render?.[1].join(' ')).toContain('measured_I=-21.3');
    expect(render?.[1].at(-1)).toBe('local-render.mp4');
    expect(dirs.every((d) => !existsSync(d))).toBe(true);
  });

  it('leaves a silent mix alone (loudnorm measures -inf)', async () => {
    fakeFfmpeg(LOUDNORM_JSON.replace('"-21.30"', '"-inf"'));
    const out = await createLocalRenderer().render(wallOfTextEdit(), { fetch: fetchImpl });
    expect(out.measuredLufs).toBeNull();
    expect(runMock.mock.calls[1]?.[1].join(' ')).not.toContain('loudnorm');
  });

  it('fails with the ffmpeg error when the render fails', async () => {
    fakeFfmpeg(LOUDNORM_JSON, 1);
    await expect(
      createLocalRenderer().render(wallOfTextEdit(), { fetch: fetchImpl }),
    ).rejects.toThrow(UpstreamServiceError);
  });

  it('refuses an edit it does not draw before running anything', async () => {
    fakeFfmpeg();
    const edit = { ...wallOfTextEdit(), output: { format: 'gif', aspectRatio: '9:16', fps: 30 } };
    await expect(createLocalRenderer().render(edit, { fetch: fetchImpl })).rejects.toThrow(
      NotImplementedError,
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it('checks for ffmpeg once', async () => {
    fakeFfmpeg();
    const renderer = createLocalRenderer();
    expect(await renderer.available()).toBe(true);
    expect(await renderer.available()).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1);
    runMock.mockRejectedValue(new ConfigurationError('ffmpeg not found'));
    expect(await createLocalRenderer().available()).toBe(false);
  });
});

describe('localRenderEnabled (STUDIO_LOCAL_RENDER)', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['on', true],
    [' ON ', true],
    ['off', false],
  ])('%s → %s', (value, expected) => {
    expect(localRenderEnabled({ STUDIO_LOCAL_RENDER: value })).toBe(expected);
  });

  it('refuses anything else', () => {
    expect(() => localRenderEnabled({ STUDIO_LOCAL_RENDER: 'yes' })).toThrow(ConfigurationError);
  });
});

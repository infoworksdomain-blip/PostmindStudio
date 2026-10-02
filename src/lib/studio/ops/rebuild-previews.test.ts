import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import type { MediaInspector, MediaProbe } from '../pipeline/media-probe';
import {
  effectiveConcurrency,
  parseRebuildPreviewsArgs,
  prismaPreviewItems,
  rebuildLibraryPreviews,
  type LibraryPreviewSource,
  type RebuildPreviewsDeps,
  type RebuildPreviewsOptions,
} from './rebuild-previews';

// BACKLOG 20.17 — the preview rebuild with mocked items, storage and media.

const BUCKET = 'studio-library-assets';
const CLIP = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

function item(n: number): LibraryPreviewSource {
  return { id: `item_${String(n).padStart(3, '0')}`, s3Bucket: BUCKET, s3Key: `library/h${n}.mp4` };
}

function probe(audioCodec: string | null): MediaProbe {
  return {
    durationSec: 20,
    width: 360,
    height: 640,
    fps: 15,
    videoCodec: 'h264',
    videoProfile: 'High',
    audioCodec,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitRateKbps: 400,
  };
}

/** `audio` maps a signed URL's key to the audio codec ffprobe reports (missing = probe fails). */
function setup(rows: LibraryPreviewSource[], audio: Record<string, string | null> = {}) {
  const page = vi.fn(async (afterId: string | undefined, take: number) =>
    rows.filter((r) => afterId === undefined || r.id > afterId).slice(0, take),
  );
  const put = vi.fn(async (input: { bucket: string; key: string }) => ({
    bucket: input.bucket,
    key: input.key,
    url: `s3://${input.bucket}/${input.key}`,
  }));
  const signedUrl = vi.fn(async (bucket: string, key: string) => `https://${bucket}.test/${key}`);
  const previewClip = vi.fn<MediaInspector['previewClip']>(async () => CLIP);
  const probeFn = vi.fn(async (url: string) => {
    const key = url.replace(`https://${BUCKET}.test/`, '');
    if (!(key in audio)) throw new ValidationError('ffprobe failed: 404 Not Found');
    return probe(audio[key] ?? null);
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps = {
    items: { page },
    storage: { put, signedUrl },
    media: { previewClip, probe: probeFn },
    log,
  } as unknown as RebuildPreviewsDeps;
  return { deps, page, put, signedUrl, previewClip, probeFn, log };
}

const base: RebuildPreviewsOptions = { dryRun: false, concurrency: 2, onlyMissingAudio: false };

describe('rebuildLibraryPreviews', () => {
  it('regenerates every preview with the ingest content type and cache header', async () => {
    const m = setup([item(1), item(2)]);
    const report = await rebuildLibraryPreviews(m.deps, base);
    expect(report).toEqual({
      dryRun: false,
      examined: 2,
      rebuilt: 2,
      skippedHasAudio: 0,
      skippedSourceSilent: 0,
      failed: [],
    });
    expect(m.previewClip).toHaveBeenCalledWith(`https://${BUCKET}.test/library/h1.mp4`, 360, 30);
    expect(m.put).toHaveBeenCalledWith({
      bucket: BUCKET,
      key: 'library/h1-preview.mp4',
      body: CLIP,
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=604800, immutable',
    });
    // Never the source key.
    expect(m.put.mock.calls.map(([input]) => input.key)).not.toContain('library/h1.mp4');
  });

  it('writes nothing and runs no ffmpeg in a dry run', async () => {
    const m = setup([item(1), item(2), item(3)]);
    const report = await rebuildLibraryPreviews(m.deps, { ...base, dryRun: true });
    expect(report).toMatchObject({ dryRun: true, examined: 3, rebuilt: 3 });
    expect(m.previewClip).not.toHaveBeenCalled();
    expect(m.put).not.toHaveBeenCalled();
  });

  it('stops after --limit items and asks the database for no more than that', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => item(i));
    const m = setup(rows);
    const report = await rebuildLibraryPreviews(m.deps, { ...base, limit: 5 });
    expect(report.examined).toBe(5);
    expect(m.put).toHaveBeenCalledTimes(5);
    expect(m.page).toHaveBeenCalledTimes(1);
    expect(m.page).toHaveBeenCalledWith(undefined, 5);
  });

  it('pages through every item by id', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => item(i));
    const m = setup(rows);
    const report = await rebuildLibraryPreviews(m.deps, { ...base, dryRun: true });
    expect(report.examined).toBe(205);
    expect(m.page.mock.calls.map(([after]) => after)).toEqual([
      undefined,
      'item_099',
      'item_199',
      'item_204',
    ]);
  });

  it('--only-missing-audio skips previews that already have sound and silent sources', async () => {
    const m = setup([item(1), item(2), item(3), item(4)], {
      'library/h1-preview.mp4': 'aac', // already rebuilt
      'library/h2-preview.mp4': null, // silent preview, source has sound → rebuild
      'library/h2.mp4': 'aac',
      'library/h3-preview.mp4': null, // silent preview and silent source → nothing to gain
      'library/h3.mp4': null,
      // h4: preview missing (probe fails), source has sound → rebuild
      'library/h4.mp4': 'mp3',
    });
    const report = await rebuildLibraryPreviews(m.deps, { ...base, onlyMissingAudio: true });
    expect(report).toMatchObject({
      examined: 4,
      rebuilt: 2,
      skippedHasAudio: 1,
      skippedSourceSilent: 1,
      failed: [],
    });
    expect(m.put.mock.calls.map(([input]) => input.key).sort()).toEqual([
      'library/h2-preview.mp4',
      'library/h4-preview.mp4',
    ]);
  });

  it('keeps going when an item fails and reports it', async () => {
    const m = setup([item(1), item(2), item(3)]);
    m.previewClip.mockImplementation(async (url: string) => {
      if (url.includes('h2.mp4')) throw new ValidationError('ffmpeg preview failed: moov atom');
      return CLIP;
    });
    const report = await rebuildLibraryPreviews(m.deps, base);
    expect(report.rebuilt).toBe(2);
    expect(report.failed).toEqual([
      { id: 'item_002', key: 'library/h2.mp4', message: 'ffmpeg preview failed: moov atom' },
    ]);
    expect(m.log.warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a source key that previewKey cannot rewrite (it would overwrite the source)', async () => {
    const m = setup([{ id: 'item_x', s3Bucket: BUCKET, s3Key: 'library/odd.mov' }]);
    const report = await rebuildLibraryPreviews(m.deps, base);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.message).toMatch(/no \.mp4 suffix/);
    expect(m.put).not.toHaveBeenCalled();
  });

  it('never runs more ffmpeg jobs at once than --concurrency', async () => {
    const m = setup(Array.from({ length: 6 }, (_, i) => item(i)));
    let running = 0;
    let peak = 0;
    m.previewClip.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return CLIP;
    });
    await rebuildLibraryPreviews(m.deps, { ...base, concurrency: 2 });
    expect(peak).toBe(2);
    expect(m.put).toHaveBeenCalledTimes(6);
  });

  it('validates limit and concurrency', async () => {
    const m = setup([]);
    await expect(rebuildLibraryPreviews(m.deps, { ...base, limit: 0 })).rejects.toThrow(
      ValidationError,
    );
    await expect(rebuildLibraryPreviews(m.deps, { ...base, concurrency: 0 })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('prismaPreviewItems', () => {
  it('reads live items only, by id, with the storage columns', async () => {
    const findMany = vi.fn(async () => [item(1)]);
    const items = prismaPreviewItems({ videoLibraryItem: { findMany } } as never);
    await items.page(undefined, 100);
    await items.page('item_001', 50);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { retiredAt: null },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, s3Bucket: true, s3Key: true },
    });
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { retiredAt: null, id: { gt: 'item_001' } },
        take: 50,
      }),
    );
  });
});

describe('effectiveConcurrency', () => {
  it('respects STUDIO_FFMPEG_MAX_CONCURRENT', () => {
    expect(effectiveConcurrency(2, {})).toBe(2);
    expect(effectiveConcurrency(2, { STUDIO_FFMPEG_MAX_CONCURRENT: '1' })).toBe(1);
    expect(effectiveConcurrency(3, { STUDIO_FFMPEG_MAX_CONCURRENT: '4' })).toBe(3);
  });
});

describe('parseRebuildPreviewsArgs', () => {
  it('defaults to a full run at concurrency 2', () => {
    expect(parseRebuildPreviewsArgs([])).toEqual({
      dryRun: false,
      concurrency: 2,
      onlyMissingAudio: false,
    });
  });

  it('reads every flag', () => {
    expect(
      parseRebuildPreviewsArgs([
        '--dry-run',
        '--limit',
        '5',
        '--concurrency',
        '3',
        '--only-missing-audio',
      ]),
    ).toEqual({ dryRun: true, limit: 5, concurrency: 3, onlyMissingAudio: true });
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseRebuildPreviewsArgs(['--limit'])).toThrow(ValidationError);
    expect(() => parseRebuildPreviewsArgs(['--limit', '0'])).toThrow(ValidationError);
    expect(() => parseRebuildPreviewsArgs(['--concurrency', '99'])).toThrow(ValidationError);
    expect(() => parseRebuildPreviewsArgs(['--bucket', 'x'])).toThrow(ValidationError);
  });
});

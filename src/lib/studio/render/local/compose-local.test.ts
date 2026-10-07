import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../../test/helpers/memory-storage';
import { NotImplementedError, UpstreamServiceError } from '../../../errors';
import type { MediaInspector } from '../../pipeline/media-probe';
import { localRenderSkipReason, renderLocalVariants, type LocalComposeDeps } from './compose-local';
import type { LocalRenderer, LocalRenderResult } from './renderer';

const RESULT: LocalRenderResult = {
  bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
  renderMs: 4_200,
  notes: ['font Arial drawn in Inter'],
  measuredLufs: -19.5,
};

function renderer(render: LocalRenderer['render'], available = true): LocalRenderer {
  return {
    providerId: 'local-ffmpeg',
    available: vi.fn(async () => available),
    render: vi.fn(render),
  };
}

function fakeDeps(localRenderer: LocalRenderer | undefined, options: { recorded?: number } = {}) {
  const jobs: Array<Record<string, unknown>> = [];
  const renders: Array<Record<string, unknown>> = [];
  const tx = {
    videoRender: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        renders.push(data);
        return { id: `render-${renders.length}`, ...data };
      }),
    },
    $executeRaw: vi.fn(async () => options.recorded ?? 1),
  };
  const db = {
    providerJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        jobs.push(data);
        return { id: `job-${jobs.length}` };
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const media = {
    probe: vi.fn(async () => ({
      durationSec: 8,
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      videoProfile: 'High',
      audioCodec: 'aac',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitRateKbps: 3_100,
    })),
    integratedLoudness: vi.fn(async () => -14.1),
  } as unknown as MediaInspector;
  const { storage, objects } = memoryStorage();
  let now = 50_000;
  const deps = {
    db,
    storage,
    media,
    logger: pino({ level: 'silent' }),
    config: { rendersBucket: 'renders' },
    fetch: vi.fn() as unknown as typeof fetch,
    localRenderer,
    now: () => (now += 10),
  } as unknown as LocalComposeDeps;
  return { deps, jobs, renders, objects, tx };
}

const variant = (id: string, aspectRatio: '9:16' | '16:9' = '9:16') => ({
  script: { id, targetPlatform: aspectRatio === '9:16' ? 'tiktok' : 'youtube' },
  aspectRatio,
  edit: { timeline: {}, output: { aspectRatio } },
  composition: { edlHash: `hash-${id}` },
});

function input(variants: ReturnType<typeof variant>[], sourceType = 'SLIDESHOW') {
  return {
    project: { id: 'project-1', organisationId: 'org-1', sourceType },
    runId: 'run-1',
    variants,
    log: pino({ level: 'silent' }),
    renders: {} as Record<string, string>,
    masteringReports: {},
  };
}

describe('renderLocalVariants', () => {
  it('renders every aspect ratio locally, stores it with the composer outputs and records 0p', async () => {
    const local = renderer(async () => RESULT);
    const { deps, jobs, renders, objects } = fakeDeps(local);
    const run = input([variant('script-a'), variant('script-b', '16:9')]);
    const out = await renderLocalVariants(deps, run);
    expect(out).toEqual({ remaining: [], stale: false });
    expect(local.render).toHaveBeenCalledTimes(2);
    expect(run.renders).toEqual({ 'script-a': 'render-1', 'script-b': 'render-2' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      organisationId: 'org-1',
      projectId: 'project-1',
      provider: 'local-ffmpeg',
      operation: 'composition',
      state: 'SUCCEEDED',
      costPence: 0,
      durationMs: 4_200,
      responseBody: { bytes: 8, measuredLufs: -19.5, notes: ['font Arial drawn in Inter'] },
    });
    expect(renders[0]).toMatchObject({
      projectId: 'project-1',
      scriptId: 'script-a',
      targetPlatform: 'tiktok',
      resolution: '1080x1920',
      s3Bucket: 'renders',
      costPence: 0,
      qualityCheckState: 'PENDING',
      composerJobId: expect.stringMatching(/^local-ffmpeg:job-\d$/),
      composition: {
        edlHash: 'hash-script-a',
        renderer: { provider: 'local-ffmpeg', renderMs: 4_200 },
      },
    });
    expect(String(renders[0]?.s3Key)).toMatch(
      /orgs\/org-1\/projects\/project-1\/providers\/local-ffmpeg\/[^/]+\.mp4$/,
    );
    expect(objects.size).toBe(2);
    expect(run.masteringReports).toMatchObject({
      'script-a': { applied: false, reasons: ['already compliant'] },
    });
  });

  it('falls back to the composer when the local render fails, and records the failure', async () => {
    const local = renderer(async () => {
      throw new UpstreamServiceError('ffmpeg local render failed: out of memory');
    });
    const { deps, jobs, renders } = fakeDeps(local);
    const v = variant('script-a');
    const out = await renderLocalVariants(deps, input([v]));
    expect(out.remaining).toEqual([v]);
    expect(renders).toEqual([]);
    expect(jobs).toEqual([
      expect.objectContaining({
        provider: 'local-ffmpeg',
        state: 'FAILED',
        costPence: 0,
        errorClass: 'UpstreamServiceError',
        errorMessage: 'ffmpeg local render failed: out of memory',
      }),
    ]);
  });

  it('sends an edit the renderer does not draw to the composer without a failure row', async () => {
    const local = renderer(async () => {
      throw new NotImplementedError('local renderer: shape asset');
    });
    const { deps, jobs } = fakeDeps(local);
    const out = await renderLocalVariants(deps, input([variant('script-a')]));
    expect(out.remaining).toHaveLength(1);
    expect(jobs).toEqual([]);
  });

  it('falls back when the render cannot be stored', async () => {
    const { deps } = fakeDeps(renderer(async () => RESULT));
    vi.spyOn(deps.storage, 'put').mockRejectedValue(new UpstreamServiceError('bucket down'));
    expect((await renderLocalVariants(deps, input([variant('a')]))).remaining).toHaveLength(1);
  });

  it('reports a superseded run', async () => {
    const { deps } = fakeDeps(
      renderer(async () => RESULT),
      { recorded: 0 },
    );
    expect(await renderLocalVariants(deps, input([variant('a')]))).toEqual({
      remaining: [],
      stale: true,
    });
  });

  it.each([
    ['HOOK_DEMO', renderer(async () => RESULT), 'source type rendered by the composer'],
    ['WALL_OF_TEXT', undefined, 'local renderer off'],
    ['SLIDESHOW', renderer(async () => RESULT, false), 'ffmpeg not available'],
  ])('%s → composer (%s)', async (sourceType, local, reason) => {
    const { deps } = fakeDeps(local);
    expect(await localRenderSkipReason(deps, sourceType)).toBe(reason);
    const v = variant('a');
    expect((await renderLocalVariants(deps, input([v], sourceType))).remaining).toEqual([v]);
    if (local) expect(local.render).not.toHaveBeenCalled();
  });

  it('does nothing without variants', async () => {
    const { deps } = fakeDeps(renderer(async () => RESULT));
    expect(await renderLocalVariants(deps, input([]))).toEqual({ remaining: [], stale: false });
  });
});

import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../../pipeline/deps';
import type { LibraryIngestJobData, LibraryReanalyseJobData } from '../queues';

// BACKLOG 20.15 — corpus workers bump the library cache version when the catalogue changes:
// ingest success (and failure: a half-written item can already show in browse) and re-analysis.

const mocks = vi.hoisted(() => ({
  ingestLibraryVideo: vi.fn(),
  reanalyseLibraryVideo: vi.fn(),
  markRunning: vi.fn(async () => undefined),
  markFinished: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
}));
vi.mock('../../library/ingest', () => ({ ingestLibraryVideo: mocks.ingestLibraryVideo }));
vi.mock('../../library/reanalyse', () => ({ reanalyseLibraryVideo: mocks.reanalyseLibraryVideo }));
vi.mock('../../library/ingest-runs', () => ({
  markRunning: mocks.markRunning,
  markFinished: mocks.markFinished,
  markFailed: mocks.markFailed,
}));

const { ingestLibraryVideoJob, onIngestLibraryVideoFailed } =
  await import('./ingest-library-video');
const { reanalyseLibraryVideoJob } = await import('./reanalyse-library-video');

const ingestData: LibraryIngestJobData = {
  organisationId: 'postmind-platform',
  runId: 'r1',
  planTier: 'STANDARD',
  item: { sourceUrl: 'https://corpus.example/a.mp4', licenseScenario: 'OWNED', tags: [] },
};
const reanalyseData: LibraryReanalyseJobData = {
  organisationId: 'postmind-platform',
  runId: 'r2',
  planTier: 'STANDARD',
  libraryItemId: 'item-1',
};

let bump: ReturnType<typeof vi.fn>;
let deps: PipelineDeps;
beforeEach(() => {
  vi.clearAllMocks();
  bump = vi.fn(async () => undefined);
  deps = {
    db: {},
    logger: pino({ level: 'silent' }),
    now: () => 0,
    libraryCache: { bump, read: vi.fn(), embedding: vi.fn() },
  } as unknown as PipelineDeps;
});

describe('library workers bump the cache version', () => {
  it('after a successful ingest', async () => {
    mocks.ingestLibraryVideo.mockResolvedValue({ libraryItemId: 'i', created: true });
    await ingestLibraryVideoJob(ingestData, deps);
    expect(bump).toHaveBeenCalledWith('ingest');
  });

  it('when an ingest finally fails', async () => {
    await onIngestLibraryVideoFailed(ingestData, deps, 'boom');
    expect(bump).toHaveBeenCalledWith('ingest-failed');
    expect(mocks.markFailed).toHaveBeenCalled();
  });

  it('not when the ingest throws (the job retries; the failure hook bumps)', async () => {
    mocks.ingestLibraryVideo.mockRejectedValue(new Error('provider down'));
    await expect(ingestLibraryVideoJob(ingestData, deps)).rejects.toThrow('provider down');
    expect(bump).not.toHaveBeenCalled();
  });

  it('after a re-analysis', async () => {
    mocks.reanalyseLibraryVideo.mockResolvedValue({
      libraryItemId: 'item-1',
      categoryChanged: false,
    });
    await reanalyseLibraryVideoJob(reanalyseData, deps);
    expect(bump).toHaveBeenCalledWith('reanalyse');
  });

  it('works without a cache (no Redis)', async () => {
    mocks.reanalyseLibraryVideo.mockResolvedValue({ libraryItemId: 'i', categoryChanged: true });
    const noCache = { ...deps, libraryCache: undefined } as PipelineDeps;
    await expect(reanalyseLibraryVideoJob(reanalyseData, noCache)).resolves.toBeUndefined();
  });
});

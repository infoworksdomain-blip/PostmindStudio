import { describe, expect, it } from 'vitest';
import { instructionSupplement } from '../queue/workers/regenerate-script';
import { scriptRegeneration } from './scripts';
import { isSwapRequest, treatmentFor } from './shot-edits';
import { assertScriptEditable, staleRenderIds } from './stale-renders';
import { probeProblem, UPLOAD_LIMITS } from './uploads';

// Pure helpers of Phase 13 track A1 (the DB paths are covered by test/api and test/golden).

const probe = {
  durationSec: 20,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  videoProfile: 'High',
  audioCodec: 'aac',
  formatName: 'mp4',
  bitRateKbps: 4000,
};

describe('scriptRegeneration', () => {
  it('only applies to the run it was requested for', () => {
    const metadata = { scriptRegenerate: { runId: 'r1', scriptId: 's1', instruction: 'Punchy' } };
    expect(scriptRegeneration(metadata, 'r1')).toEqual({
      runId: 'r1',
      scriptId: 's1',
      instruction: 'Punchy',
      pinnedShotIds: [], // 15.C9: none pinned
    });
    expect(scriptRegeneration(metadata, 'r2')).toBeNull();
    expect(scriptRegeneration(null, 'r1')).toBeNull();
    expect(
      scriptRegeneration({ scriptRegenerate: { runId: 'r1', scriptId: 's1' } }, 'r1')?.instruction,
    ).toBeNull();
  });
});

describe('instructionSupplement', () => {
  it('fences the owner instruction and cannot be broken out of', () => {
    expect(instructionSupplement(null)).toBeUndefined();
    const text = instructionSupplement('Mention """Saturday""" class') ?? '';
    expect(text.match(/"""/g)).toHaveLength(2);
    expect(text).toContain('Saturday');
  });
});

describe('shot edit helpers', () => {
  it('detects asset swaps and picks the treatment that shows the asset', () => {
    expect(isSwapRequest({ assetId: 'a' })).toBe(true);
    expect(isSwapRequest({ imageLibraryId: 'i' })).toBe(true);
    expect(isSwapRequest({ voiceoverText: 'x' })).toBe(false);
    expect(isSwapRequest(undefined)).toBe(false);
    expect(treatmentFor('IMAGE')).toBe('IMAGE_STILL');
    expect(treatmentFor('VIDEO_CLIP')).toBe('USER_UPLOAD');
  });
});

describe('stale renders', () => {
  it('reads the stale list defensively', () => {
    expect(staleRenderIds({ staleRenders: ['r1', 2, 'r2'] })).toEqual(['r1', 'r2']);
    expect(staleRenderIds({})).toEqual([]);
    expect(staleRenderIds(null)).toEqual([]);
  });

  it('allows script edits only on finished projects', () => {
    expect(() => assertScriptEditable('READY_FOR_REVIEW')).not.toThrow();
    expect(() => assertScriptEditable('RENDERING')).toThrow(/finished/);
  });
});

describe('probeProblem', () => {
  it('accepts a normal video and rejects audio-only, too short or too long files', () => {
    expect(probeProblem('source_video', probe)).toBeNull();
    expect(probeProblem('source_video', { ...probe, width: 0, height: 0 })).toMatch(/no video/);
    expect(probeProblem('source_video', { ...probe, durationSec: 0.2 })).toMatch(/at least/);
    expect(
      probeProblem('source_video', {
        ...probe,
        durationSec: UPLOAD_LIMITS.source_video.maxSec + 1,
      }),
    ).toMatch(/at most/);
    expect(probeProblem('slide_clip', { ...probe, durationSec: 121 })).toMatch(/at most/);
  });
});

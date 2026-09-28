import { describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from './deps';
import { spokenLanguageOf } from './word-timing';

function depsWith(shot: unknown, project: unknown) {
  const videoShot = { findUnique: vi.fn().mockResolvedValue(shot) };
  const videoProject = { findUnique: vi.fn().mockResolvedValue(project) };
  return {
    deps: { db: { videoShot, videoProject } } as unknown as PipelineDeps,
    videoShot,
    videoProject,
  };
}

describe('spokenLanguageOf (15.C5)', () => {
  it("uses the shot's script language", async () => {
    const { deps, videoProject } = depsWith({ script: { language: 'hi' } }, { language: 'en-GB' });
    await expect(spokenLanguageOf(deps, { shotId: 's1', projectId: 'p1' })).resolves.toBe('hi');
    expect(videoProject.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the project's language for assets without a shot", async () => {
    const { deps, videoShot } = depsWith(null, { language: 'zh-Hans' });
    await expect(spokenLanguageOf(deps, { shotId: null, projectId: 'p1' })).resolves.toBe(
      'zh-Hans',
    );
    expect(videoShot.findUnique).not.toHaveBeenCalled();
  });

  it('returns undefined when neither is found', async () => {
    const { deps } = depsWith(null, null);
    await expect(
      spokenLanguageOf(deps, { shotId: 'gone', projectId: 'gone' }),
    ).resolves.toBeUndefined();
  });
});

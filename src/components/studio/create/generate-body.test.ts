import { describe, expect, it } from 'vitest';
import { EMPTY_HOOK_DEMO, type CreateState } from './body';
import {
  buildGenerateBody,
  modelsForTier,
  runTier,
  usesVideoModel,
  type VideoModelView,
} from './generate-body';

const base: CreateState = {
  brief: 'Spring menu',
  source: 'BRIEF',
  platforms: ['tiktok'],
  length: 'short',
  brandKitId: null,
  templateId: null,
  targetAudience: '',
  callToAction: '',
  budgetPounds: '',
  reviewPolicy: '',
  projectTemplate: null,
  autoPublish: false,
  autoPublishAccounts: {},
};

function model(providerId: string, tiers: VideoModelView['tiers']): VideoModelView {
  return {
    providerId,
    displayName: providerId,
    capabilities: ['text_to_video'],
    maxClipSec: 10,
    aspectRatios: ['9:16'],
    audio: false,
    typicalLatencySec: 120,
    tiers,
  };
}

describe('buildGenerateBody (15.C4, 25.8)', () => {
  it('sends nothing for Automatic and the plan’s own tier', () => {
    expect(buildGenerateBody(base, ['veo'])).toEqual({});
    expect(buildGenerateBody({ ...base, videoModel: null }, ['veo'])).toEqual({});
  });

  it('sends the chosen model as the AI_CLIP preference when the server accepts it', () => {
    expect(buildGenerateBody({ ...base, videoModel: 'veo' }, ['seedance', 'veo'])).toEqual({
      preferredProviders: { AI_CLIP: ['veo'] },
    });
    expect(
      buildGenerateBody({ ...base, videoModel: 'kling', qualityTier: 'BASIC' }, ['kling']),
    ).toEqual({ qualityTier: 'BASIC', preferredProviders: { AI_CLIP: ['kling'] } });
  });

  it('drops a model the run’s tier does not offer instead of failing validation', () => {
    expect(buildGenerateBody({ ...base, videoModel: 'runway' }, ['seedance'])).toEqual({});
    expect(buildGenerateBody({ ...base, videoModel: 'runway' })).toEqual({});
  });

  it('never sends a model for formats without AI clips', () => {
    for (const source of ['SLIDESHOW', 'CAROUSEL', 'UPLOAD', 'WALL_OF_TEXT'] as const)
      expect(buildGenerateBody({ ...base, source, videoModel: 'veo' }, ['veo'])).toEqual({});
    expect(
      buildGenerateBody(
        { ...base, source: 'HOOK_DEMO', hookDemo: { ...EMPTY_HOOK_DEMO, hookSource: 'library' } },
        ['veo'],
      ),
    ).toEqual({});
  });
});

describe('video model helpers', () => {
  it('usesVideoModel: AI video, UGC and an AI-made hook', () => {
    expect(usesVideoModel({ source: 'BRIEF' })).toBe(true);
    expect(usesVideoModel({ source: 'UGC' })).toBe(true);
    expect(usesVideoModel({ source: 'HOOK_DEMO', hookDemo: EMPTY_HOOK_DEMO })).toBe(true);
    expect(usesVideoModel({ source: 'SLIDESHOW' })).toBe(false);
  });

  it('runTier: the lower tier chosen, else the plan', () => {
    expect(runTier({ qualityTier: '' }, 'PLUS')).toBe('PLUS');
    expect(runTier({ qualityTier: 'BASIC' }, 'PLUS')).toBe('BASIC');
    expect(runTier({}, undefined)).toBeUndefined();
  });

  it('modelsForTier keeps the models the tier’s candidate list names', () => {
    const models = [model('seedance', ['BASIC', 'STANDARD']), model('runway', ['STANDARD'])];
    expect(modelsForTier(models, 'BASIC').map((m) => m.providerId)).toEqual(['seedance']);
    expect(modelsForTier(models, 'STANDARD')).toHaveLength(2);
    expect(modelsForTier(undefined, 'STANDARD')).toEqual([]);
    expect(modelsForTier(models, undefined)).toEqual([]);
  });
});

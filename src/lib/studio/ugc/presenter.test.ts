import { describe, expect, it, vi } from 'vitest';
import {
  loadPresenterStyle,
  presenterActorImageOf,
  presenterClipPrompt,
  presenterSeed,
  presenterSkipReason,
} from './presenter';
import { actorDescription, MAX_UGC_SEED, newUgcStyle } from './style';
import { clipSpeaks } from './clip-speech';

// 23.2 — AI_AVATAR presenters made by the actor route.

const base = {
  voiceoverText: 'Still buying supermarket bread?',
  language: 'en-GB',
  durationSec: 6,
  sceneDescription: 'stands at the bakery counter',
  actorProviderIds: ['veo', 'kling'],
};

describe('presenterSkipReason', () => {
  it('takes the actor route for a short English line in a 4–8 s shot', () => {
    expect(presenterSkipReason(base)).toBeNull();
    expect(presenterSkipReason({ ...base, preferredProviderId: 'veo' })).toBeNull();
  });

  it.each([
    [{ voiceoverText: ' ' }, 'no_line'],
    [{ language: 'fr-FR' }, 'language'],
    [{ durationSec: 10 }, 'duration'],
    [{ durationSec: 3 }, 'duration'],
    [
      { durationSec: 4, voiceoverText: 'one two three four five six seven eight nine ten' },
      'line_too_long',
    ],
    [{ sceneDescription: 'a presenter who looks like Taylor Swift' }, 'real_person'],
    [{ preferredProviderId: 'heygen' }, 'provider_chosen'],
    [{ brandHasCustomAvatar: true }, 'custom_avatar'],
  ] as const)('goes to the avatar route when %j (%s)', (overrides, reason) => {
    expect(presenterSkipReason({ ...base, ...overrides })).toBe(reason);
  });
});

describe('presenter look', () => {
  it('a stable seed per project in the provider seed range', () => {
    expect(presenterSeed('p1')).toBe(presenterSeed('p1'));
    expect(presenterSeed('p1')).not.toBe(presenterSeed('p2'));
    expect(presenterSeed('p1')).toBeGreaterThanOrEqual(0);
    expect(presenterSeed('p1')).toBeLessThanOrEqual(MAX_UGC_SEED);
  });

  it('uses the business default READY creator with a portrait (22.3)', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'cr1',
      portraitId: 'pt1',
      description: 'a man in his fifties, grey beard',
      voiceTone: 'calm',
      ageRange: '45-60',
      gender: 'man',
      setting: 'shop',
    });
    const style = await loadPresenterStyle({ creator: { findFirst } } as never, {
      id: 'p1',
      organisationId: 'o1',
      businessId: 'b1',
    });
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { organisationId: 'o1', businessId: 'b1', isDefault: true, status: 'READY' },
    });
    expect(style.creator).toEqual({
      id: 'cr1',
      portraitId: 'pt1',
      description: 'a man in his fifties, grey beard',
      voiceTone: 'calm',
    });
    expect(actorDescription(style)).toContain('grey beard');
  });

  it('otherwise a one-off presenter from the project seed (never a kitchen)', async () => {
    const style = await loadPresenterStyle(
      { creator: { findFirst: vi.fn().mockResolvedValue(null) } } as never,
      { id: 'p1', organisationId: 'o1', businessId: 'b1' },
    );
    expect(style.creator).toBeUndefined();
    expect(style.seed).toBe(presenterSeed('p1'));
    expect(style.product).toEqual({ name: null, imageId: null });
    expect(style.actor.setting).not.toBe('kitchen');
  });

  it('the clip prompt follows the video shape and never contains the line', () => {
    const style = newUgcStyle({}, 3);
    const landscape = presenterClipPrompt({
      style,
      sceneDescription: 'at the counter',
      actorReference: true,
      aspectRatio: '16:9',
    });
    expect(landscape).toMatch(/^Landscape creator-style video/);
    expect(landscape).toContain('same person as in the reference portrait');
    expect(landscape).toContain('exactly once');
    expect(
      presenterClipPrompt({
        style,
        sceneDescription: 'x',
        actorReference: false,
        aspectRatio: '9:16',
      }),
    ).toMatch(/^Vertical/);
  });
});

describe('presenter state and clip speech', () => {
  it('reads metadata.presenter.actorImage (never metadata.ugc)', () => {
    expect(
      presenterActorImageOf({
        presenter: { actorImage: { state: 'ready', description: 'd', assetId: 'a1' } },
      }).state,
    ).toEqual({ state: 'ready', description: 'd', assetId: 'a1' });
    expect(presenterActorImageOf({ ugc: { actorImage: { state: 'ready' } } }).state).toBeNull();
  });

  it('an actor-route presenter speaks its own line; a HeyGen one has narration', () => {
    expect(clipSpeaks({ visualTreatment: 'AI_AVATAR', voiceAssetId: null, assetId: 'a' })).toBe(
      true,
    );
    expect(clipSpeaks({ visualTreatment: 'AI_AVATAR', voiceAssetId: 'v', assetId: 'a' })).toBe(
      false,
    );
    expect(clipSpeaks({ visualTreatment: 'AI_CLIP', voiceAssetId: null, assetId: 'a' })).toBe(
      false,
    );
  });
});

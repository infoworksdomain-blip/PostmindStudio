import { describe, expect, it } from 'vitest';
import {
  CostCapPausedError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  ProviderError,
  ProvidersUnavailableError,
  ValidationError,
} from '../../errors';
import {
  avatarUnavailableReason,
  degradedClipDurationSec,
  degradedClipPrompt,
  degradedShotsOf,
} from './avatar-fallback';

// BACKLOG 20.19 — when an AI_AVATAR shot degrades to a generated clip, and when it must not.

const noProvider = (skips: Array<string | undefined>) =>
  new NoProviderAvailableError('No provider available for avatar_video', {
    capability: 'avatar_video',
    candidates: skips.map((skipped, i) => ({ providerId: `p${i}`, ...(skipped && { skipped }) })),
  });

describe('avatarUnavailableReason', () => {
  it('degrades when every avatar provider failed with an account problem', () => {
    const err = new ProvidersUnavailableError('avatar_video', [
      { providerId: 'heygen', errorClass: 'insufficient_credits' },
    ]);
    expect(avatarUnavailableReason(err)).toBe('insufficient_credits');
  });

  it.each([
    [['not_configured', 'account_unavailable'], 'account_unavailable'],
    [['not_configured', 'provider_disabled'], 'provider_disabled'],
    [['not_configured', 'circuit_open'], 'circuit_open'],
    [['not_configured', 'over_budget'], 'over_budget'],
    [['not_configured', 'not_configured'], 'not_configured'],
  ])('degrades when no avatar provider can be routed (%j → %s)', (skips, reason) => {
    expect(avatarUnavailableReason(noProvider(skips))).toBe(reason);
  });

  it('degrades on an account-class provider error and a provider-level kill switch', () => {
    expect(
      avatarUnavailableReason(new ProviderError('heygen', 'auth', 'unauthorized: bad key', false)),
    ).toBe('auth');
    expect(
      avatarUnavailableReason(new KillSwitchTriggeredError('provider', 'heygen is disabled')),
    ).toBe('provider_disabled');
  });

  it('does not degrade a content refusal, a bad request, a cost-cap pause or a wider kill', () => {
    expect(
      avatarUnavailableReason(
        new ProviderError('heygen', 'content_policy', 'content_policy_violation: no', false),
      ),
    ).toBeNull();
    expect(
      avatarUnavailableReason(new ProviderError('heygen', 'invalid_request', 'bad', false)),
    ).toBeNull();
    expect(
      avatarUnavailableReason(new ProviderError('heygen', 'provider_unavailable', 'x', true)),
    ).toBeNull();
    expect(avatarUnavailableReason(new ValidationError('no voiceover'))).toBeNull();
    expect(avatarUnavailableReason(new CostCapPausedError('project', 'paused'))).toBeNull();
    expect(
      avatarUnavailableReason(new KillSwitchTriggeredError('workspace', 'workspace frozen')),
    ).toBeNull();
  });
});

describe('degradedClipPrompt', () => {
  it('asks for B-roll that illustrates the narration, without a presenter', () => {
    const prompt = degradedClipPrompt({
      sceneDescription: 'Presenter at the counter',
      voiceoverText: 'Our sourdough is "baked" at dawn.',
      cameraDirection: 'slow push-in',
      toneKeywords: ['warm', 'crafted'],
    });
    expect(prompt).toBe(
      'Cinematic B-roll that visually illustrates this line: "Our sourdough is \'baked\' at dawn.". ' +
        'Setting and context: Presenter at the counter. ' +
        'No presenter, nobody speaking to camera, no on-screen text, logos or captions. ' +
        'Polished, brand-appropriate look; mood: warm, crafted. Camera: slow push-in.',
    );
  });

  it('stays short and works without narration, camera or tone', () => {
    const prompt = degradedClipPrompt({
      sceneDescription: 'x'.repeat(2_000),
      voiceoverText: null,
    });
    expect(prompt.startsWith('Cinematic B-roll for a short brand video.')).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(900);
    expect(prompt).not.toContain('Camera:');
  });
});

describe('degradedClipDurationSec', () => {
  it.each([
    [1, 2],
    [4.2, 5],
    [6, 6],
    [10, 10],
    [12, 10],
  ])('%ss shot → %ss clip', (shot, clip) => {
    expect(degradedClipDurationSec(shot)).toBe(clip);
  });
});

describe('degradedShotsOf', () => {
  it('lists shots whose visual routing records a degradation', () => {
    expect(
      degradedShotsOf([
        {
          id: 's1',
          providerRouting: {
            visual: { providerId: 'runway', degradedFrom: 'avatar_video', degradedReason: 'auth' },
          },
        },
        { id: 's2', providerRouting: { visual: { providerId: 'runway' } } },
        { id: 's3', providerRouting: null },
        { id: 's4', providerRouting: { visual: { degradedFrom: 'avatar_video' } } },
      ]),
    ).toEqual([
      { shotId: 's1', degradedFrom: 'avatar_video', reason: 'auth' },
      { shotId: 's4', degradedFrom: 'avatar_video', reason: 'unknown' },
    ]);
  });
});

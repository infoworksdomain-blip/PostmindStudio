import { describe, expect, it } from 'vitest';
import {
  assetFingerprint,
  candidateProviders,
  normalisePrompt,
  providerOfSource,
} from './asset-reuse';
import { withEdlHash } from './compose-cache';
import { edlHash, storedEdlHash } from './edl-hash';
import { fallbackFrom, shotFallbacks } from './fallback-notice';
import { platformCardFromEnv, uploadedFontId, hostedFontUrl } from './brand-resolve';
import { fontFamilyFor, isRtl, scriptOf, textFontFor } from '../i18n/scripts';

// Phase 15 Track B helpers: 15.B6 fingerprints + EDL hash, 15.B9 fallback notices, brand
// resolution helpers (15.B1 / P2) and the shared script → font module.

describe('15.B6 fingerprints', () => {
  it('ignores case/whitespace in visual prompts but not in narration', () => {
    const a = assetFingerprint('runway', {
      capability: 'text_to_video',
      prompt: 'Golden  Loaf',
      durationSec: 5,
      aspectRatio: '9:16',
    });
    const b = assetFingerprint('runway', {
      capability: 'text_to_video',
      prompt: 'golden loaf',
      durationSec: 5,
      aspectRatio: '9:16',
    });
    expect(a).toBe(b);
    expect(
      assetFingerprint('luma', {
        capability: 'text_to_video',
        prompt: 'golden loaf',
        durationSec: 5,
        aspectRatio: '9:16',
      }),
    ).not.toBe(a);
    expect(
      assetFingerprint('runway', {
        capability: 'text_to_video',
        prompt: 'golden loaf',
        durationSec: 6,
        aspectRatio: '9:16',
      }),
    ).not.toBe(a);
    expect(normalisePrompt('tts', ' Hello  World ')).toBe('Hello World');
    expect(providerOfSource('runway:gen4')).toBe('runway');
  });

  it('lists the tier’s candidate providers in preference order', () => {
    expect(candidateProviders({ kind: 'capability', capability: 'tts' }, 'BASIC')[0]).toBe(
      'elevenlabs',
    );
    expect(
      candidateProviders({ kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 5 }, 'STANDARD'),
    ).toContain('runway');
  });
});

describe('15.B6 EDL hash', () => {
  it('is stable across signed-URL signatures and key order, and changes with content', () => {
    const one = {
      timeline: {
        tracks: [{ clips: [{ asset: { src: 'https://s3/b/k.mp4?X-Sig=1' }, start: 0 }] }],
      },
      output: { fps: 30 },
    };
    const two = {
      output: { fps: 30 },
      timeline: {
        tracks: [{ clips: [{ start: 0, asset: { src: 'https://s3/b/k.mp4?X-Sig=2' } }] }],
      },
    };
    expect(edlHash(one)).toBe(edlHash(two));
    expect(edlHash({ ...one, output: { fps: 60 } })).not.toBe(edlHash(one));
    const hash = edlHash(one);
    expect(storedEdlHash(withEdlHash(null, hash))).toBe(hash);
    expect(storedEdlHash({ edlHash: 'nope' })).toBeNull();
    expect(storedEdlHash(null)).toBeNull();
  });
});

describe('15.B9 fallback notices', () => {
  it('reports run-time skips of preferred providers, not unconfigured ones', () => {
    expect(
      fallbackFrom(
        {
          providerId: 'luma',
          candidates: [{ providerId: 'runway', skipped: 'circuit_open' }, { providerId: 'luma' }],
        },
        'visual',
        'shot-1',
      ),
    ).toEqual({
      layer: 'visual',
      shotId: 'shot-1',
      usedProviderId: 'luma',
      skipped: [{ providerId: 'runway', reason: 'circuit_open' }],
    });
    expect(
      fallbackFrom(
        {
          providerId: 'luma',
          candidates: [{ providerId: 'veo', skipped: 'not_configured' }, { providerId: 'luma' }],
        },
        'visual',
      ),
    ).toBeNull();
    expect(fallbackFrom({ nonsense: true }, 'voice')).toBeNull();
    expect(
      shotFallbacks('s', {
        visual: { providerId: 'runway', candidates: [{ providerId: 'runway' }] },
        voice: {
          providerId: 'azure-speech',
          candidates: [
            { providerId: 'elevenlabs', skipped: 'over_budget' },
            { providerId: 'azure-speech' },
          ],
        },
      }),
    ).toHaveLength(1);
  });
});

describe('brand resolution helpers', () => {
  it('parses uploaded-font references and builds hosted font URLs', () => {
    expect(uploadedFontId('upload:fnt_1')).toBe('fnt_1');
    expect(uploadedFontId('Inter')).toBeNull();
    expect(hostedFontUrl('https://fonts.test/', 'Noto Sans Arabic')).toBe(
      'https://fonts.test/NotoSansArabic.ttf',
    );
  });

  it('P2: the platform card needs an https URL and is off by default', () => {
    expect(platformCardFromEnv({})).toBeUndefined();
    expect(platformCardFromEnv({ STUDIO_MADE_WITH_CARD_URL: 'http://x/card.png' })).toBeUndefined();
    expect(platformCardFromEnv({ STUDIO_MADE_WITH_CARD_URL: 'https://cdn/card.png' })).toEqual({
      src: 'https://cdn/card.png',
      kind: 'image',
    });
  });
});

describe('i18n/scripts', () => {
  it('maps languages to scripts, fonts and direction', () => {
    expect(scriptOf('ar')).toBe('arabic');
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en-GB')).toBe(false);
    expect(scriptOf('unknown')).toBe('latin');
    expect(fontFamilyFor('han')).toBe('Noto Sans SC');
    expect(textFontFor('hi', 'Brandon')).toBe('Noto Sans Devanagari');
    expect(textFontFor('fr', 'Brandon')).toBe('Brandon');
    expect(textFontFor('fr', null)).toBe('Noto Sans');
  });
});

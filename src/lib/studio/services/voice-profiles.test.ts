import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../tenant';
import {
  assertVoiceCloneTier,
  MAX_SAMPLE_BYTES,
  MAX_SAMPLES,
  parseVoiceProfileForm,
  voiceCloneMinTier,
} from './voice-profiles';

const tenant = (planTier: string): TenantContext => ({
  userId: 'u',
  organisationId: 'o',
  organisation: { id: 'o', planTier },
  memberships: [],
  capabilities: [],
});

const audio = (name: string, size = 3, type = 'audio/mpeg') =>
  new File([new Uint8Array(size)], name, { type });

function form(overrides: Record<string, string | File[] | File | null> = {}): FormData {
  const f = new FormData();
  const fields: Record<string, string | File[] | File | null> = {
    name: 'Amara (owner)',
    speakerName: 'Amara Okafor',
    consentStatement:
      'I, Amara Okafor, consent to PostMind Studio creating a synthetic copy of my voice.',
    consent: 'true',
    consentRecording: audio('consent.mp3'),
    samples: [audio('a.mp3'), audio('b.wav', 3, 'audio/wav')],
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (Array.isArray(value)) for (const v of value) f.append(key, v);
    else f.append(key, value);
  }
  return f;
}

describe('voice clone tier gating (spec 13.4)', () => {
  it('defaults to PLUS (operator decision P4); STUDIO_VOICE_CLONE_MIN_TIER moves it', () => {
    expect(voiceCloneMinTier({})).toBe('PLUS');
    expect(voiceCloneMinTier({ STUDIO_VOICE_CLONE_MIN_TIER: 'enterprise' })).toBe('ENTERPRISE');
    expect(voiceCloneMinTier({ STUDIO_VOICE_CLONE_MIN_TIER: 'nonsense' })).toBe('PLUS');
    expect(() => assertVoiceCloneTier(tenant('ENTERPRISE'), {})).not.toThrow();
    expect(() => assertVoiceCloneTier(tenant('PLUS'), {})).not.toThrow();
    expect(() => assertVoiceCloneTier(tenant('STANDARD'), {})).toThrow('PLUS');
    expect(() =>
      assertVoiceCloneTier(tenant('PLUS'), { STUDIO_VOICE_CLONE_MIN_TIER: 'ENTERPRISE' }),
    ).toThrow('ENTERPRISE');
  });
});

describe('parseVoiceProfileForm', () => {
  it('parses fields, samples and the consent recording', async () => {
    const input = await parseVoiceProfileForm(form({ businessId: 'biz-1' }));
    expect(input.fields.name).toBe('Amara (owner)');
    expect(input.fields.businessId).toBe('biz-1');
    expect(input.samples.map((s) => s.contentType)).toEqual(['audio/mpeg', 'audio/wav']);
    expect(input.consentRecording.filename).toBe('consent.mp3');
  });

  it('17.8: records the consent statement locale and catalogue key when they are valid', async () => {
    const input = await parseVoiceProfileForm(
      form({
        consentStatementLocale: 'ar',
        consentStatementKey: 'business.voice.cloneDialog.consentPhrase',
      }),
    );
    expect(input.fields.consentStatementLocale).toBe('ar');
    expect(input.fields.consentStatementKey).toBe('business.voice.cloneDialog.consentPhrase');
    expect((await parseVoiceProfileForm(form())).fields.consentStatementKey).toBeUndefined();
    await expect(parseVoiceProfileForm(form({ consentStatementLocale: 'xx-YY' }))).rejects.toThrow(
      'validation',
    );
    await expect(
      parseVoiceProfileForm(form({ consentStatementKey: 'business.scan.ownershipStatement' })),
    ).rejects.toThrow('validation');
  });

  it('requires consent=true, a speaker, a real consent statement and a recording', async () => {
    await expect(parseVoiceProfileForm(form({ consent: 'false' }))).rejects.toThrow('validation');
    await expect(parseVoiceProfileForm(form({ consent: null }))).rejects.toThrow('validation');
    await expect(parseVoiceProfileForm(form({ speakerName: null }))).rejects.toThrow('validation');
    await expect(parseVoiceProfileForm(form({ consentStatement: 'ok' }))).rejects.toThrow(
      'validation',
    );
    await expect(parseVoiceProfileForm(form({ consentRecording: null }))).rejects.toThrow(
      'consentRecording is required',
    );
  });

  it('limits samples: 1–5 audio files of at most 10 MB', async () => {
    await expect(parseVoiceProfileForm(form({ samples: [] }))).rejects.toThrow('At least one');
    await expect(
      parseVoiceProfileForm(
        form({ samples: Array.from({ length: MAX_SAMPLES + 1 }, (_, i) => audio(`${i}.mp3`)) }),
      ),
    ).rejects.toThrow(`At most ${MAX_SAMPLES}`);
    await expect(
      parseVoiceProfileForm(form({ samples: [audio('big.mp3', MAX_SAMPLE_BYTES + 1)] })),
    ).rejects.toThrow('10 MB');
    await expect(
      parseVoiceProfileForm(form({ samples: [audio('x.png', 3, 'image/png')] })),
    ).rejects.toThrow('audio file');
    await expect(parseVoiceProfileForm(form({ samples: [audio('empty.mp3', 0)] }))).rejects.toThrow(
      'empty',
    );
  });
});

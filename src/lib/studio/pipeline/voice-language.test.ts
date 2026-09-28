import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../languages';
import {
  LANGUAGE_CODE_MODELS,
  defaultVoiceIdFor,
  elevenLabsLanguageCode,
  ttsLanguageCode,
  voiceEnvKey,
} from './voice-language';

describe('voiceEnvKey', () => {
  it('upper-cases the tag and replaces hyphens', () => {
    expect(voiceEnvKey('zh-Hans')).toBe('ELEVENLABS_DEFAULT_VOICE_ID_ZH_HANS');
    expect(voiceEnvKey('pt-br')).toBe('ELEVENLABS_DEFAULT_VOICE_ID_PT_BR');
    expect(voiceEnvKey('ar')).toBe('ELEVENLABS_DEFAULT_VOICE_ID_AR');
  });
});

describe('defaultVoiceIdFor', () => {
  it('prefers the per-language voice', () => {
    const env = { ELEVENLABS_DEFAULT_VOICE_ID_AR: ' voice-ar ' };
    expect(defaultVoiceIdFor('ar', 'global', env)).toBe('voice-ar');
  });

  it('falls back to the base-language voice (pt-BR → _PT)', () => {
    expect(defaultVoiceIdFor('pt-BR', 'global', { ELEVENLABS_DEFAULT_VOICE_ID_PT: 'pt' })).toBe(
      'pt',
    );
    expect(
      defaultVoiceIdFor('pt-BR', 'global', {
        ELEVENLABS_DEFAULT_VOICE_ID_PT: 'pt',
        ELEVENLABS_DEFAULT_VOICE_ID_PT_BR: 'pt-br',
      }),
    ).toBe('pt-br');
  });

  it('falls back to the global default, then undefined', () => {
    expect(defaultVoiceIdFor('hi', 'global', { ELEVENLABS_DEFAULT_VOICE_ID_AR: 'x' })).toBe(
      'global',
    );
    expect(defaultVoiceIdFor('hi', undefined, {})).toBeUndefined();
    expect(defaultVoiceIdFor('hi', '  ', { ELEVENLABS_DEFAULT_VOICE_ID_HI: '' })).toBeUndefined();
  });

  it('treats unknown tags as en-GB', () => {
    expect(defaultVoiceIdFor('xx', 'g', { ELEVENLABS_DEFAULT_VOICE_ID_EN_GB: 'uk' })).toBe('uk');
  });
});

describe('ttsLanguageCode', () => {
  it('maps every Studio language to its ISO 639-1 code', () => {
    for (const language of LANGUAGES) {
      expect(ttsLanguageCode(language.code)).toMatch(/^[a-z]{2}$/);
    }
    expect(ttsLanguageCode('zh-Hans')).toBe('zh');
    expect(ttsLanguageCode('pt-PT')).toBe('pt');
  });
});

describe('elevenLabsLanguageCode', () => {
  it('is sent only for models documented to accept language_code', () => {
    expect([...LANGUAGE_CODE_MODELS].sort()).toEqual(['eleven_flash_v2_5', 'eleven_v3']);
    expect(elevenLabsLanguageCode('eleven_flash_v2_5', 'ar')).toBe('ar');
    expect(elevenLabsLanguageCode('eleven_v3', 'zh-Hans')).toBe('zh');
    expect(elevenLabsLanguageCode('eleven_multilingual_v2', 'ar')).toBeUndefined();
    expect(elevenLabsLanguageCode('eleven_flash_v2', 'ar')).toBeUndefined();
    expect(elevenLabsLanguageCode('eleven_v3', undefined)).toBeUndefined();
  });
});

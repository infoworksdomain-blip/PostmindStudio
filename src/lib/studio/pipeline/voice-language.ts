import { languageOf } from '../languages';

// 15.C5 (spec 5.5, Layer 4) — narration in the script's language (video_scripts.language).
//
// ElevenLabs, read 2026-09-28:
//   - https://elevenlabs.io/docs/overview/models — eleven_multilingual_v2 speaks 29 languages
//     ("English (USA, UK, Australia, Canada), Japanese, Chinese, German, Hindi, French …,
//     Portuguese (Brazil, Portugal), Italian, Spanish …, Arabic (Saudi Arabia, UAE) …");
//     eleven_flash_v2_5 adds Hungarian, Norwegian and Vietnamese; eleven_v3 covers 70+ languages.
//     eleven_flash_v2 is English-only. Every Studio language is therefore speakable by the
//     multilingual models with any multilingual voice — the per-language default below is a
//     quality choice (a native-accent voice), not a requirement.
//   - https://elevenlabs.io/docs/api-reference/text-to-speech/convert — body `language_code`:
//     "Language code (ISO 639-1) used to enforce a language for the model and text
//     normalization. If the model does not support the provided language code, it will be
//     ignored. This parameter is not supported for multilingual_v2 models."
//     So it is sent only for the models below (not eleven_multilingual_v2, the default).
//   - Voice ids: ElevenLabs app → Voices (My Voices / Voice Library) → a voice → "Copy voice ID",
//     or GET /v2/voices. No voice id is hardcoded here; the operator configures them.
//
// Voice precedence (generate-asset.ts resolveVoiceId): a READY brand-kit clone always wins
// (voice_profiles.languagesSupported records what the clone was verified on; ElevenLabs clones
// speak other languages through the multilingual models, with the source accent) → the 15.B3
// tone-matched stock voice → ELEVENLABS_DEFAULT_VOICE_ID_<LANG> → ELEVENLABS_DEFAULT_VOICE_ID.

/** ElevenLabs models whose TTS endpoint accepts `language_code` (see header). */
export const LANGUAGE_CODE_MODELS: ReadonlySet<string> = new Set([
  'eleven_v3',
  'eleven_flash_v2_5',
]);

/** Env var holding the default voice for a language: en-GB → ELEVENLABS_DEFAULT_VOICE_ID_EN_GB. */
export function voiceEnvKey(languageCode: string): string {
  return `ELEVENLABS_DEFAULT_VOICE_ID_${languageOf(languageCode).code.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The default narration voice for a script language: the per-language env voice, then the
 * per-base-language one (pt-BR → _PT), then the global default. Undefined when none is set.
 */
export function defaultVoiceIdFor(
  languageCode: string | null | undefined,
  globalDefault: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const language = languageOf(languageCode);
  const keys = [
    voiceEnvKey(language.code),
    `ELEVENLABS_DEFAULT_VOICE_ID_${language.base.toUpperCase()}`,
  ];
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return globalDefault?.trim() || undefined;
}

/** ISO 639-1 code of a script language (what TtsRequest.languageCode carries). */
export function ttsLanguageCode(languageCode: string | null | undefined): string {
  return languageOf(languageCode).base;
}

/** The `language_code` to send to ElevenLabs for a model, or undefined when it is unsupported. */
export function elevenLabsLanguageCode(
  model: string,
  languageCode: string | null | undefined,
): string | undefined {
  if (!languageCode || !LANGUAGE_CODE_MODELS.has(model)) return undefined;
  return languageCode.trim().toLowerCase().split('-')[0] || undefined;
}

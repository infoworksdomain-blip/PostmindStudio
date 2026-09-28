import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { ApiError, useErrorMessage } from '@/lib/client/api';
import { useFormat, type Tone } from '@/lib/client/format';

// BACKLOG 13.13 — voice profiles (services/voice-profiles.ts presentVoiceProfile) as the browser
// sees them, plus the client-side limits that mirror the service's upload rules.

export type VoiceProfileState = 'READY' | 'REQUIRES_VERIFICATION' | 'DELETED';

export interface VoiceProfile {
  id: string;
  businessId: string | null;
  name: string;
  provider: 'elevenlabs';
  state: VoiceProfileState;
  isDefault: boolean;
  speakerName: string | null;
  consentGivenAt: string | null;
  sampleCount: number;
  languagesSupported: string[];
  createdAt: string;
  deletedAt: string | null;
}

export const MAX_VOICE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_SAMPLES = 5;
export const MIN_CONSENT_CHARS = 20;
export const MAX_CONSENT_CHARS = 1000;
export const MAX_PREVIEW_CHARS = 300;

const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|ogg|webm|flac)$/i;

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name);
}

export type AudioFileProblem = 'notAudio' | 'empty' | 'tooLarge';

/** The first problem with a file (a business.voice.fileProblems key), or null when it can be uploaded. */
export function audioFileProblem(file: File): AudioFileProblem | null {
  if (!isAudioFile(file)) return 'notAudio';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_VOICE_FILE_BYTES) return 'tooLarge';
  return null;
}

/** audioFileProblem() as a sentence in the active locale. */
export function useAudioFileProblem(): (file: File) => string | null {
  const t = useTranslations('business.voice.fileProblems');
  return useCallback(
    (file: File) => {
      const problem = audioFileProblem(file);
      return problem ? t(problem, { name: file.name }) : null;
    },
    [t],
  );
}

/** Bytes → "512 B", "4 KB", "1.5 MB" with the locale's digits and decimal separator. */
export function useFormatBytes(): (bytes: number) => string {
  const t = useTranslations('business.voice.bytes');
  const f = useFormat();
  return useCallback(
    (bytes: number) => {
      if (bytes < 1024) return t('b', { n: f.number(bytes) });
      if (bytes < 1024 * 1024) return t('kb', { n: f.number(Math.round(bytes / 1024)) });
      const mb = f.number(bytes / 1024 / 1024, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      return t('mb', { n: mb });
    },
    [t, f],
  );
}

/** The default consent statement (mirrors DEFAULT_CONSENT_PHRASE in services/voice-profiles.ts). */
export function useConsentStatement(): (speaker: string, business: string) => string {
  const t = useTranslations('business.voice.cloneDialog');
  return useCallback(
    (speaker: string, business: string) =>
      t('consentPhrase', {
        name: speaker.trim() || t('yourName'),
        business: business.trim() || t('thisBusiness'),
      }),
    [t],
  );
}

export const VOICE_STATE_TONE: Record<VoiceProfileState, Tone> = {
  READY: 'good',
  REQUIRES_VERIFICATION: 'warn',
  DELETED: 'neutral',
};

const PLAN_IN_MESSAGE = /on the (\w+) plan/i;

function requiredTier(err: ApiError): string | null {
  const tier = err.details?.requiredTier;
  if (typeof tier === 'string') return tier;
  return PLAN_IN_MESSAGE.exec(err.message)?.[1] ?? null;
}

/**
 * errorMessage() turns every 403 into a generic permission sentence; for voice cloning the 403
 * is the plan gate, so it names the plan the business needs. 501 means the server has no
 * ElevenLabs key.
 */
export function useVoiceErrorMessage(): (err: unknown) => string {
  const t = useTranslations('business.voice.errors');
  const errorMessage = useErrorMessage();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 403 && /plan/i.test(err.message)) {
        const tier = requiredTier(err);
        return tier ? t('plan', { tier }) : t('planGeneric');
      }
      if (err instanceof ApiError && err.status === 501)
        return t('notConfigured', { message: err.message });
      return errorMessage(err);
    },
    [t, errorMessage],
  );
}

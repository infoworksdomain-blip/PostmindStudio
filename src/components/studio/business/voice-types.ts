import { ApiError, errorMessage } from '@/lib/client/api';
import type { Tone } from '@/lib/client/format';

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
export const DEFAULT_PREVIEW_TEXT = 'Fresh bread every Friday';

/** Mirrors DEFAULT_CONSENT_PHRASE in services/voice-profiles.ts. */
export const DEFAULT_CONSENT_PHRASE =
  'I, {name}, consent to PostMind Studio creating a synthetic copy of my voice for {business} videos.';

export function consentStatement(speaker: string, business: string): string {
  return DEFAULT_CONSENT_PHRASE.replace('{name}', speaker.trim() || '[your name]').replace(
    '{business}',
    business.trim() || 'this business',
  );
}

const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|ogg|webm|flac)$/i;

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name);
}

/** The first problem with a file, or null when it can be uploaded. */
export function audioFileProblem(file: File): string | null {
  if (!isAudioFile(file)) return `${file.name} is not an audio file.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_VOICE_FILE_BYTES) return `${file.name} is larger than 10 MB.`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const VOICE_STATE: Record<VoiceProfileState, { label: string; tone: Tone }> = {
  READY: { label: 'Ready', tone: 'good' },
  REQUIRES_VERIFICATION: { label: 'Needs verification', tone: 'warn' },
  DELETED: { label: 'Deleted', tone: 'neutral' },
};

/**
 * errorMessage() turns every 403 into a generic permission sentence; for voice cloning the 403
 * is the plan gate, so its own message ("Voice cloning is available on the ENTERPRISE plan") is
 * kept. 501 means the server has no ElevenLabs key.
 */
export function voiceErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 403 && /plan/i.test(err.message))
    return `${err.message}. Upgrade your plan to clone a voice; stock voices are still available.`;
  if (err instanceof ApiError && err.status === 501)
    return `Voice cloning isn’t set up on this server yet (${err.message}).`;
  return errorMessage(err);
}

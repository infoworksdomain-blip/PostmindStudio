// Phase 13 item 13.13 demo handlers: voice profiles (spec 10.2 / 13.4). Shapes match
// src/app/api/studio/voice-profiles/** and services/voice-profiles.ts presentVoiceProfile. The
// preview is a short tone synthesised in the browser as a WAV data: URL (no ElevenLabs call).
import { DEMO_BUSINESS_ID, DEMO_USER_NAME } from '../ids';
import { DemoHttpError, route } from '../registry';
import { unlinkVoiceProfile } from './business-brand-kits';

interface DemoVoiceProfile {
  id: string;
  businessId: string | null;
  name: string;
  provider: 'elevenlabs';
  state: 'READY' | 'REQUIRES_VERIFICATION' | 'DELETED';
  isDefault: boolean;
  speakerName: string | null;
  consentGivenAt: string | null;
  sampleCount: number;
  languagesSupported: string[];
  createdAt: string;
  deletedAt: string | null;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SAMPLES = 5;
const DAY = 86_400_000;
const seededAt = new Date(Date.now() - 21 * DAY).toISOString();

const profiles: DemoVoiceProfile[] = [
  {
    id: 'vp-amara-owner',
    businessId: DEMO_BUSINESS_ID,
    name: 'Amara (owner)',
    provider: 'elevenlabs',
    state: 'READY',
    isDefault: false,
    speakerName: DEMO_USER_NAME,
    consentGivenAt: seededAt,
    sampleCount: 2,
    languagesSupported: ['en'],
    createdAt: seededAt,
    deletedAt: null,
  },
];

const bad = (problems: string[]) =>
  new DemoHttpError(400, 'validation_error', 'Voice profile form failed validation', {
    problems,
  });

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
};

const isAudio = (v: FormDataEntryValue): v is File =>
  typeof v !== 'string' && v.type.startsWith('audio/') && v.size > 0 && v.size <= MAX_FILE_BYTES;

function find(id: string): DemoVoiceProfile {
  const p = profiles.find((x) => x.id === id && x.state !== 'DELETED');
  if (!p) throw new DemoHttpError(404, 'not_found', 'Voice profile not found');
  return p;
}

/** A 16-bit mono PCM WAV of a soft two-note chime, as a data: URL. */
function toneWav(seconds: number): string {
  const rate = 16_000;
  const n = Math.floor(rate * seconds);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => buf.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  buf.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  ascii(36, 'data');
  buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const freq = t < seconds / 2 ? 440 : 554.37;
    const env = Math.min(1, t * 20) * Math.exp(-3 * (t % (seconds / 2)));
    buf.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * t) * env * 9000), true);
  }
  let binary = '';
  const bytes = new Uint8Array(buf.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

route('GET', '/voice-profiles', ({ query }) => {
  const businessId = query.get('businessId');
  return {
    data: profiles
      .filter((p) => p.state !== 'DELETED' && (!businessId || p.businessId === businessId))
      .map((p) => ({ ...p })),
  };
});

route('POST', '/voice-profiles', ({ body }) => {
  if (!(body instanceof FormData)) throw bad(['Upload must be multipart/form-data']);
  const problems: string[] = [];
  const name = text(body, 'name');
  const speakerName = text(body, 'speakerName');
  const statement = text(body, 'consentStatement');
  if (!name || name.length > 80) problems.push('name: must be 1–80 characters');
  if (!speakerName || speakerName.length > 120)
    problems.push('speakerName: must be 1–120 characters');
  if (statement.length < 20 || statement.length > 1000)
    problems.push('consentStatement: must be 20–1000 characters');
  if (text(body, 'consent') !== 'true')
    problems.push('consent must be true: the speaker must consent to their voice being cloned');
  const samples = body.getAll('samples');
  if (samples.length === 0 || samples.length > MAX_SAMPLES)
    problems.push(`samples: 1–${MAX_SAMPLES} audio files are required`);
  else if (!samples.every(isAudio)) problems.push('samples: audio files of at most 10 MB each');
  const consent = body.get('consentRecording');
  if (!consent || !isAudio(consent))
    problems.push('consentRecording is required: record the speaker reading the consent statement');
  if (problems.length) throw bad(problems);
  const now = new Date().toISOString();
  const created: DemoVoiceProfile = {
    id: `vp-${Date.now().toString(36)}`,
    businessId: text(body, 'businessId') || null,
    name,
    provider: 'elevenlabs',
    state: 'READY',
    isDefault: false,
    speakerName,
    consentGivenAt: now,
    sampleCount: samples.length,
    languagesSupported: ['en'],
    createdAt: now,
    deletedAt: null,
  };
  profiles.push(created);
  return { status: 201, body: { voiceProfile: { ...created } } };
});

route('DELETE', '/voice-profiles/:id', ({ params }) => {
  const profile = find(params.id ?? '');
  profile.state = 'DELETED';
  profile.deletedAt = new Date().toISOString();
  return { deleted: true, brandKitsUnlinked: unlinkVoiceProfile(profile.id) };
});

route('POST', '/voice-profiles/:id/preview', ({ params, body }) => {
  const profile = find(params.id ?? '');
  const input = (body ?? {}) as { text?: unknown };
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 300)
    throw new DemoHttpError(400, 'validation_error', 'Invalid request body', {
      problems: ['text: must be 1–300 characters'],
    });
  if (profile.state !== 'READY')
    throw new DemoHttpError(409, 'conflict', 'Voice profile is not ready');
  return { previewUrl: toneWav(1.2), expiresInSec: 600 };
});

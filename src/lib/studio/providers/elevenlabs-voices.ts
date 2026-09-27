import { classifyHttpStatus, classifyNetworkError, providerError } from './provider-errors';
import { BASE_URL } from './elevenlabs';

// BACKLOG 13.13 — ElevenLabs Instant Voice Cloning (spec 10.2: "Studio uploads to ElevenLabs
// Voice Cloning API and stores the ElevenLabs voice ID"). Contracts read 2026-09-27:
//   Create IVC voice — https://elevenlabs.io/docs/api-reference/voices/ivc/create
//     POST https://api.elevenlabs.io/v1/voices/add, header xi-api-key, multipart/form-data:
//       name (required), files (required, one part per recording), remove_background_noise?,
//       description?, labels? → 200 { voice_id, requires_verification }
//   Delete voice — https://elevenlabs.io/docs/api-reference/voices/delete
//     DELETE https://api.elevenlabs.io/v1/voices/{voice_id} → 200 { status: "ok" }
// Samples: "1–2 minutes of clear audio … the total combined length is the important part";
// "MP3, 192kbps or higher" recommended; the user must "confirm that you have the right and
// consent to clone the voice" (https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/
// instant-voice-cloning, …/help-center/product/voices/voice-cloning/what-files-do-you-accept-for-
// voice-cloning). The API reference gives no per-file size or count limit, so Studio's own caps
// (voice-profiles service) apply. Not used: `labels` (the reference types it as an object without
// saying how it is encoded in multipart).

export const PROVIDER_ID = 'elevenlabs';
const REQUEST_TIMEOUT_MS = 120_000;

export interface VoiceSample {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface CreatedVoice {
  voiceId: string;
  requiresVerification: boolean;
}

/** What Studio needs from a voice-cloning provider (tests use a fake). */
export interface VoiceCloningClient {
  readonly providerId: string;
  addVoice(input: {
    name: string;
    description?: string;
    samples: VoiceSample[];
    removeBackgroundNoise?: boolean;
  }): Promise<CreatedVoice>;
  /** Idempotent: a voice the provider no longer has counts as deleted. */
  deleteVoice(voiceId: string): Promise<void>;
}

function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  const d = detail as { message?: string; status?: string; code?: string } | undefined;
  return `${d?.code ?? d?.status ?? status}: ${d?.message ?? 'request failed'}`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class ElevenLabsVoiceCloning implements VoiceCloningClient {
  readonly providerId = PROVIDER_ID;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async send(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { 'xi-api-key': this.options.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
    }
    return { status: res.status, body: await readJson(res) };
  }

  async addVoice(input: {
    name: string;
    description?: string;
    samples: VoiceSample[];
    removeBackgroundNoise?: boolean;
  }): Promise<CreatedVoice> {
    const form = new FormData();
    form.append('name', input.name);
    if (input.description) form.append('description', input.description);
    if (input.removeBackgroundNoise !== undefined)
      form.append('remove_background_noise', String(input.removeBackgroundNoise));
    for (const sample of input.samples) {
      form.append(
        'files',
        new Blob([sample.bytes as Uint8Array<ArrayBuffer>], { type: sample.contentType }),
        sample.filename,
      );
    }
    const res = await this.send(`${BASE_URL}/v1/voices/add`, { method: 'POST', body: form });
    if (res.status < 200 || res.status >= 300)
      throw providerError(
        PROVIDER_ID,
        classifyHttpStatus(res.status),
        errorMessage(res.body, res.status),
        { status: res.status },
      );
    const body = res.body as { voice_id?: unknown; requires_verification?: unknown } | null;
    if (typeof body?.voice_id !== 'string' || body.voice_id === '')
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: false },
        'ElevenLabs returned no voice_id',
      );
    return { voiceId: body.voice_id, requiresVerification: body.requires_verification === true };
  }

  async deleteVoice(voiceId: string): Promise<void> {
    const res = await this.send(`${BASE_URL}/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return; // already gone at the provider
    if (res.status < 200 || res.status >= 300)
      throw providerError(
        PROVIDER_ID,
        classifyHttpStatus(res.status),
        errorMessage(res.body, res.status),
        { status: res.status },
      );
  }
}

/** Built from ELEVENLABS_API_KEY; undefined when the key is not set. */
export function voiceCloningFromEnv(
  env: Record<string, string | undefined> = process.env,
): VoiceCloningClient | undefined {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  return apiKey ? new ElevenLabsVoiceCloning({ apiKey }) : undefined;
}

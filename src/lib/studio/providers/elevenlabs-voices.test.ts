import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ElevenLabsVoiceCloning, voiceCloningFromEnv } from './elevenlabs-voices';

const sample = (name: string) => ({
  bytes: new Uint8Array([1, 2, 3]),
  filename: name,
  contentType: 'audio/mpeg',
});

describe('ElevenLabsVoiceCloning (docs: /v1/voices/add, /v1/voices/{id})', () => {
  it('POSTs multipart name, description and one files part per sample', async () => {
    const { fetch, requests } = fakeFetch(json({ voice_id: 'v_1', requires_verification: false }));
    const client = new ElevenLabsVoiceCloning({ apiKey: 'key', fetchImpl: fetch });
    const voice = await client.addVoice({
      name: 'Amara',
      description: 'Owner',
      samples: [sample('a.mp3'), sample('b.mp3')],
      removeBackgroundNoise: true,
    });
    expect(voice).toEqual({ voiceId: 'v_1', requiresVerification: false });
    const req = requests[0];
    expect(req?.url).toBe('https://api.elevenlabs.io/v1/voices/add');
    expect(req?.method).toBe('POST');
    expect(req?.headers['xi-api-key']).toBe('key');
    const form = req?.body as FormData;
    expect(form.get('name')).toBe('Amara');
    expect(form.get('description')).toBe('Owner');
    expect(form.get('remove_background_noise')).toBe('true');
    const files = form.getAll('files') as File[];
    expect(files.map((f) => f.name)).toEqual(['a.mp3', 'b.mp3']);
    expect(files[0]?.type).toBe('audio/mpeg');
  });

  it('reports requires_verification', async () => {
    const { fetch } = fakeFetch(json({ voice_id: 'v_2', requires_verification: true }));
    const client = new ElevenLabsVoiceCloning({ apiKey: 'k', fetchImpl: fetch });
    expect(
      (await client.addVoice({ name: 'x', samples: [sample('a.mp3')] })).requiresVerification,
    ).toBe(true);
  });

  it('maps errors: 401 auth, 422 invalid, missing voice_id', async () => {
    const { fetch } = fakeFetch(
      json({ detail: { status: 'invalid_api_key', message: 'bad key' } }, 401),
      json({ detail: [{ msg: 'files required' }] }, 422),
      json({}),
    );
    const client = new ElevenLabsVoiceCloning({ apiKey: 'k', fetchImpl: fetch });
    await expect(client.addVoice({ name: 'x', samples: [] })).rejects.toMatchObject({
      errorClass: 'auth',
    });
    await expect(client.addVoice({ name: 'x', samples: [] })).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    await expect(client.addVoice({ name: 'x', samples: [] })).rejects.toThrow('no voice_id');
  });

  it('DELETEs the voice; a voice already gone is fine; other errors throw', async () => {
    const { fetch, requests } = fakeFetch(
      json({ status: 'ok' }),
      json({ detail: 'not found' }, 404),
      json({ detail: 'boom' }, 500),
    );
    const client = new ElevenLabsVoiceCloning({ apiKey: 'k', fetchImpl: fetch });
    await client.deleteVoice('v/1');
    expect(requests[0]?.url).toBe('https://api.elevenlabs.io/v1/voices/v%2F1');
    expect(requests[0]?.method).toBe('DELETE');
    await client.deleteVoice('gone');
    await expect(client.deleteVoice('v')).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
    });
  });

  it('is only built when ELEVENLABS_API_KEY is set', () => {
    expect(voiceCloningFromEnv({})).toBeUndefined();
    expect(voiceCloningFromEnv({ ELEVENLABS_API_KEY: 'k' })?.providerId).toBe('elevenlabs');
  });
});

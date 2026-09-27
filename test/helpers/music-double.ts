import { randomUUID } from 'node:crypto';
import type { ProviderPollResult, ProviderRequest } from '../../src/lib/studio/providers/interface';
import { ScriptedAdapter } from './scripted-adapter';

// Scripted stand-in for ElevenLabsMusicAdapter: same provider id, capability and output
// metadata shape (s3Bucket/s3Key/durationSec/model/costPence), 3p per track.

export function musicDouble(
  respond?: (request: ProviderRequest) => ProviderPollResult,
): ScriptedAdapter {
  return new ScriptedAdapter(
    'elevenlabs-music',
    ['music'],
    respond ??
      ((request) => {
        const sec = request.capability === 'music' ? request.durationSec : 0;
        return {
          state: 'succeeded',
          output: {
            url: 'https://signed.invalid/music.mp3',
            metadata: {
              model: 'music_v2_5',
              s3Bucket: 'assets',
              s3Key: `orgs/${request.organisationId}/music-${randomUUID()}.mp3`,
              durationSec: sec,
              bytes: 1234,
              costPence: 3,
            },
          },
        };
      }),
    3,
  );
}

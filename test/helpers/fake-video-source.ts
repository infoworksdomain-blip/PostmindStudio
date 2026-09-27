import type { AspectRatio } from '../../src/lib/studio/providers/interface';
import type { VideoSource } from '../../src/lib/studio/platforms/interface';

// A tiny in-memory VideoSource for publisher tests: backs `read(start, endInclusive)` with a
// real Uint8Array slice so publishers that inspect byte lengths (content-length headers, chunk
// math) see consistent data without any real file or network I/O.

export function fakeVideoSource(
  overrides: Partial<VideoSource> & { sizeBytes: number },
): VideoSource {
  const bytes = new Uint8Array(overrides.sizeBytes);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  return {
    sizeBytes: overrides.sizeBytes,
    contentType: 'video/mp4',
    durationSec: overrides.durationSec ?? 30,
    aspectRatio: overrides.aspectRatio ?? ('9:16' as AspectRatio),
    signedUrl: overrides.signedUrl ?? 'https://storage.example/render.mp4',
    read:
      overrides.read ??
      ((start: number, endInclusive: number) =>
        Promise.resolve(bytes.slice(start, endInclusive + 1))),
  };
}

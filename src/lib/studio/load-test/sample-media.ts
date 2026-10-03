import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

// 20.29 load-test harness — small sample media made once with FFmpeg's test sources (lavfi), so
// the simulated providers return real files and the pipeline's FFmpeg checks do real work:
//   clip.mp4    720×1280, 4 s, 24 fps, silent (an AI clip)
//   render.mp4  1080×1920, 30 s, 30 fps, H.264 + AAC tone (a Shotstack render; the quality gate
//               probes it, runs blackdetect and loudness, and mastering may re-encode it)
//   voice.mp3   3 s tone (narration), music.mp3 30 s tone, still.png 1024×1024

const run = promisify(execFile);

export interface SampleMedia {
  clip: string;
  render: string;
  voice: string;
  music: string;
  still: string;
}

export function sampleMediaCommands(dir: string, ffmpeg = 'ffmpeg'): Array<[string, string[]]> {
  const base = [ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error']] as const;
  const cmd = (args: string[]): [string, string[]] => [base[0], [...base[1], ...args]];
  return [
    cmd([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=720x1280:rate=24:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'clip.mp4'),
    ]),
    cmd([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1080x1920:rate=30:duration=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=30',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-af',
      'volume=-18dB',
      '-shortest',
      join(dir, 'render.mp4'),
    ]),
    cmd([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=3',
      '-q:a',
      '6',
      join(dir, 'voice.mp3'),
    ]),
    cmd([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=30',
      '-q:a',
      '6',
      join(dir, 'music.mp3'),
    ]),
    cmd([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1024x1024:duration=1',
      '-frames:v',
      '1',
      join(dir, 'still.png'),
    ]),
  ];
}

export async function makeSampleMedia(dir: string, ffmpeg = 'ffmpeg'): Promise<SampleMedia> {
  await mkdir(dir, { recursive: true });
  for (const [bin, args] of sampleMediaCommands(dir, ffmpeg)) await run(bin, args);
  return {
    clip: join(dir, 'clip.mp4'),
    render: join(dir, 'render.mp4'),
    voice: join(dir, 'voice.mp3'),
    music: join(dir, 'music.mp3'),
    still: join(dir, 'still.png'),
  };
}

export async function readSample(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

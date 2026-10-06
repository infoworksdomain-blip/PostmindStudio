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
//   render-15.mp4, render-8.mp4  the same render at 15 s and 8 s (22.1 / 22.2: a hook + demo
//               and a wall-of-text video pass the duration check against their own length)

const run = promisify(execFile);

/** 22.1 / 22.2: the default lengths of a hook + demo video and a wall-of-text video. */
export const SHORT_RENDER_SECONDS = [15, 8] as const;

export interface SampleMedia {
  clip: string;
  render: string;
  /** Renders of these lengths (seconds → path); the 30 s render covers every other length. */
  shortRenders: Record<number, string>;
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
    cmd(renderArgs(30, join(dir, 'render.mp4'))),
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
    ...SHORT_RENDER_SECONDS.map((sec) => cmd(renderArgs(sec, join(dir, `render-${sec}.mp4`)))),
  ];
}

/** A Shotstack-like render: 1080×1920, 30 fps, H.264 high + AAC tone at a gate-friendly level. */
function renderArgs(sec: number, out: string): string[] {
  return [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1080x1920:rate=30:duration=${sec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${sec}`,
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
    out,
  ];
}

export async function makeSampleMedia(dir: string, ffmpeg = 'ffmpeg'): Promise<SampleMedia> {
  await mkdir(dir, { recursive: true });
  for (const [bin, args] of sampleMediaCommands(dir, ffmpeg)) await run(bin, args);
  return {
    clip: join(dir, 'clip.mp4'),
    render: join(dir, 'render.mp4'),
    shortRenders: Object.fromEntries(
      SHORT_RENDER_SECONDS.map((sec) => [sec, join(dir, `render-${sec}.mp4`)]),
    ),
    voice: join(dir, 'voice.mp3'),
    music: join(dir, 'music.mp3'),
    still: join(dir, 'still.png'),
  };
}

export async function readSample(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

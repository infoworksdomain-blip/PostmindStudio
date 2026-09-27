import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveStyle } from '../../src/lib/studio/overlays/params';
import { preRenderOverlay } from '../../src/lib/studio/overlays/prerender';
import type { OverlayRow } from '../../src/lib/studio/overlays/shotstack';
import { memoryStorage } from '../helpers/memory-storage';

// BACKLOG 8.4 against real ffmpeg (CI installs it): counter, glitch and karaoke overlays render
// to ProRes 4444 with an alpha channel. Skipped where ffmpeg or a system TTF is unavailable.

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:/Windows/Fonts/arial.ttf'].find(
  (f) => existsSync(f),
);
const ready = spawnSync(ffmpeg, ['-version']).status === 0 && Boolean(FONT);

describe.skipIf(!ready)('overlay pre-render with real ffmpeg', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-prerender-'));
  const fontBytes = FONT ? readFileSync(FONT) : Buffer.alloc(0);
  const fetchImpl = (async () => new Response(fontBytes)) as unknown as typeof fetch;

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const overlay = (animationIn: OverlayRow['animationIn'], text: string): OverlayRow => ({
    ...resolveStyle({ animationIn, fontFamily: 'DejaVu Sans', fontSizePct: 8 }),
    id: `o-${animationIn}`,
    text,
    startAtSec: 0,
    endAtSec: 1.5,
  });

  for (const [animation, text] of [
    ['counter', '1,200+ loaves'],
    ['glitch', "Don't miss: 50% off!"],
    ['karaokeHighlight', 'Baked fresh every single morning'],
  ] as const) {
    it(`renders ${animation} as a transparent ProRes 4444 MOV`, async () => {
      const { storage, objects } = memoryStorage();
      const url = await preRenderOverlay(
        { storage, bucket: 'renders', fetchImpl, fontsBaseUrl: 'https://fonts.test' },
        'org-media',
        overlay(animation, text),
        { width: 540, height: 960 },
      );
      expect(url).toContain('/renders/orgs/org-media/overlays/');
      const [object] = [...objects.values()];
      expect(object?.contentType).toBe('video/quicktime');
      const file = join(dir, `${animation}.mov`);
      writeFileSync(file, object?.body ?? new Uint8Array());
      const probe = JSON.parse(
        execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file]).toString(),
      ) as {
        streams: Array<{ codec_name: string; pix_fmt: string; width: number; height: number }>;
      };
      expect(probe.streams[0]).toMatchObject({
        codec_name: 'prores',
        pix_fmt: 'yuva444p10le',
        width: 540,
        height: 960,
      });
    });
  }
});

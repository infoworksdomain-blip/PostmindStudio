import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FRAME,
  maxDiffRatio,
  pngDiffRatio,
  presetCases,
  referencePng,
  renderFfmpeg,
  renderPreview,
  visualEnv,
  type Browser,
  type VisualEnv,
} from './harness';

// BACKLOG 15.D10 / A14.2 — per built-in preset pixel diff (harness.ts). Needs ffmpeg,
// Playwright + Chromium and VISUAL_FONTS_DIR; without them the suite is skipped and its name
// says why. Run: .github/workflows/visual-regression.yml, or locally per
// runbooks/slo-and-launch-readiness.md "Overlay pixel diff".
//   * FFmpeg pre-render vs HTML preview — asserted for the presets production pre-renders
//     (karaoke / counter / glitch); for the rest FFmpeg drawtext is only a proxy (no boxes,
//     shadows or rounded backgrounds), so their ratio is asserted only with VISUAL_STRICT_FFMPEG=1.
//   * Shotstack reference vs HTML preview — asserted for every preset whose reference PNG the
//     operator has captured (test/visual/references/<key>.png); missing ones are skipped.

const visual = await visualEnv();
const skip = 'skip' in visual ? visual.skip : null;
const strict = process.env.VISUAL_STRICT_FFMPEG === '1';
const max = maxDiffRatio();

describe.skipIf(skip !== null)(
  `overlay preset pixel diff${skip ? ` (skipped: ${skip})` : ''}`,
  () => {
    const env = visual as VisualEnv;
    let browser: Browser;
    beforeAll(async () => {
      browser = await env.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    for (const c of presetCases()) {
      it(`${c.key}: FFmpeg pre-render matches the HTML preview`, async () => {
        const [html, ffmpeg] = await Promise.all([
          renderPreview(browser, c, env.fontsDir),
          renderFfmpeg(env, c),
        ]);
        const ratio = await pngDiffRatio(html, ffmpeg, FRAME);
        if (c.preRendered || strict) expect(ratio).toBeLessThanOrEqual(max);
        else expect(ratio).toBeGreaterThanOrEqual(0);
      });

      const reference = referencePng(c.key);
      it.skipIf(!reference)(`${c.key}: HTML preview matches the Shotstack reference`, async () => {
        const html = await renderPreview(browser, c, env.fontsDir);
        expect(await pngDiffRatio(html, reference as Buffer, FRAME)).toBeLessThanOrEqual(max);
      });
    }
  },
);

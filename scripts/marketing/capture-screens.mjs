// Phase 20.8 / 25.5 — captures the landing page's product screens (script, image library,
// calendar, analytics) from the demo build, in the light and the dark theme, and writes them as
// WebP to public/marketing/screens/<screen>-<theme>.webp (1200×750, the size
// src/lib/marketing/media.ts declares). 25.5 dropped the brief and review captures (the review
// screen listed a "Content safety" check Studio no longer runs).
//
//   node scripts/demo/build.mjs
//   node scripts/demo/serve.mjs 3021 demo/dist/postmind-studio-demo.html   (in another shell)
//   node scripts/marketing/capture-screens.mjs [http://127.0.0.1:3021/] [--out <dir>]
//
// The screens show the demo's sample business (Leeds Sourdough) and its sample data. The demo bar
// and the plan-usage banner and account notices are hidden so the product screen fills the frame.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir =
  outFlag > -1 ? resolve(args[outFlag + 1]) : join(root, 'public', 'marketing', 'screens');
const base =
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? 'http://127.0.0.1:3021/';

const WIDTH = 1200;
const HEIGHT = 750;
const HIDE = `[aria-label="Demo build"], section[aria-label="Plan usage"], section[aria-label="Account notices"] { display: none !important; }
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`;

const wait = (page, ms) => page.waitForTimeout(ms);

async function openTab(page, name) {
  await page.getByRole('tab', { name, exact: true }).first().click();
  await wait(page, 1200);
}

async function scrollTo(page, locator, offset = 76) {
  await locator.first().evaluate((el, off) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off);
  }, offset);
  await wait(page, 400);
}

/** Each step: the hash route, then what to do before the screenshot. */
const STEPS = {
  script: {
    route: '/projects/prj-untitled-rye',
    async act(page) {
      await openTab(page, 'Script');
      await scrollTo(page, page.getByRole('tablist'));
    },
  },
  generate: {
    route: '/business',
    async act(page) {
      await openTab(page, 'Image library');
      await wait(page, 1500);
      await scrollTo(page, page.getByRole('tablist'));
    },
  },
  calendar: { route: '/calendar', async act() {} },
  analytics: { route: '/analytics', async act() {} },
};

async function capture(browser, theme) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('theme', t);
    } catch {
      // storage blocked: the theme stays light
    }
  }, theme);
  const page = await context.newPage();
  await page.goto(base);
  await wait(page, 1500);
  await page
    .getByRole('button', { name: /Enter app as sample user/i })
    .first()
    .click();
  await wait(page, 1500);
  await page.addStyleTag({ content: HIDE });
  for (const [step, { route, act }] of Object.entries(STEPS)) {
    await page.evaluate((h) => {
      location.hash = h;
    }, route);
    await wait(page, 2500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await act(page);
    const png = await page.screenshot({ type: 'png' });
    const file = join(outDir, `${step}-${theme}.webp`);
    const info = await sharp(png)
      .resize(WIDTH, HEIGHT)
      .webp({ quality: 72, effort: 6 })
      .toFile(file);
    process.stdout.write(`${file}  ${info.width}x${info.height}  ${info.size} bytes\n`);
  }
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) await capture(browser, theme);
} finally {
  await browser.close();
}

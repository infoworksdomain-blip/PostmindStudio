// Builds the self-contained demo page: the real Studio screens + in-browser sample API, bundled
// into one HTML file (inline CSS, fonts and JS) that can be opened anywhere or published.
//
//   node scripts/demo/build.mjs                  → demo/dist/postmind-studio-demo.html
//   node scripts/demo/build.mjs --out <file>     → a separate copy (parallel previews)
//
// Tailwind 4 compiles src/app/globals.css (the app's own tokens) scanning src/ and demo/; esbuild
// bundles demo/entry.tsx with next/link and next/navigation swapped for demo/shims.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { build } from 'esbuild';
import postcss from 'postcss';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outFlag = process.argv.indexOf('--out');
const out =
  outFlag > -1 && process.argv[outFlag + 1]
    ? resolve(process.argv[outFlag + 1])
    : join(root, 'demo', 'dist', 'postmind-studio-demo.html');

async function css() {
  const input = join(root, 'demo', 'demo.css');
  const result = await postcss([tailwind({ base: root })]).process(readFileSync(input, 'utf8'), {
    from: input,
  });
  const fonts = await build({
    entryPoints: [join(root, 'demo', 'fonts.css')],
    bundle: true,
    write: false,
    minify: true,
    loader: { '.woff2': 'dataurl' },
  });
  const minified = await build({
    stdin: { contents: result.css, loader: 'css', resolveDir: join(root, 'demo') },
    bundle: false,
    write: false,
    minify: true,
  });
  return fonts.outputFiles[0].text + minified.outputFiles[0].text;
}

// Full-page navigations (sign-in / sign-out, org switch, OAuth, Stripe, downloads) go through
// src/lib/client/navigate.ts in the app; the demo swaps it for a shim that stays inside the
// hash-routed page. A plugin rather than `alias`, because the import is a tsconfig path.
const hardNavigateShim = {
  name: 'demo-hard-navigate',
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/client\/navigate$/ }, () => ({
      path: join(root, 'demo', 'shims', 'hard-navigate.ts'),
    }));
    // Phase 20.8: marketing photos and screens are inlined (data: URLs) instead of /marketing/….
    b.onResolve({ filter: /(^@\/lib\/marketing|^\.)\/media-src$/ }, (args) =>
      args.path.startsWith('@') ||
      args.importer.replaceAll('\\', '/').includes('src/lib/marketing/')
        ? { path: join(root, 'demo', 'shims', 'marketing-media-src.ts') }
        : undefined,
    );
    // The email previews (#/tour/email/*) render the real templates; their catalogue reads the
    // template list from lib/email/auth-mailer.ts, whose server-only sender lazily imports the API
    // context (Prisma, BullMQ). Left as an import() that never runs in the demo.
    b.onResolve({ filter: /\/studio\/api\/context$/ }, (args) =>
      args.importer.replaceAll('\\', '/').endsWith('src/lib/email/auth-mailer.ts')
        ? { path: args.path, external: true }
        : undefined,
    );
  },
};

async function js() {
  const result = await build({
    plugins: [hardNavigateShim],
    entryPoints: [join(root, 'demo', 'entry.tsx')],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    // Phase 18: the legal pages render content/legal/en-GB/*.md (text) in the demo.
    loader: { '.md': 'text', '.webp': 'dataurl' },
    tsconfig: join(root, 'tsconfig.json'),
    alias: {
      'next/link': join(root, 'demo', 'shims', 'next-link.tsx'),
      'next/navigation': join(root, 'demo', 'shims', 'next-navigation.ts'),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_STUDIO_DEMO': '"1"',
    },
    logLevel: 'warning',
    // 'use client' directives are meaningless in a single bundle.
    logOverride: { 'unsupported-directive': 'silent' },
  });
  return result.outputFiles[0].text;
}

const [styles, script] = await Promise.all([css(), js()]);
const safeScript = script.replace(/<\/script/gi, '<\\/script');
const html = `<title>PostMind Studio Demo</title>
<meta name="description" content="Clickable demo of the PostMind Studio build with sample data.">
<style>${styles}</style>
<div id="studio-demo-root"></div>
<script>${safeScript}</script>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
const kb = (n) => `${Math.round(n / 1024)} KB`;
process.stdout.write(
  `demo built: ${out}\n  css ${kb(styles.length)}  js ${kb(script.length)}  total ${kb(html.length)}\n`,
);

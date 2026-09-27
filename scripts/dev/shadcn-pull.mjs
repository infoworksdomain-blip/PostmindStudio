/* eslint-disable no-console -- CLI script output */
// Pulls shadcn/ui components from the official registry (ui.shadcn.com/r/styles/<style>) into
// src/components/ui — what `npx shadcn add` does. The CLI can't be used here: it runs
// `npm install --allow-scripts`, which npm 12 rejects in project-scoped installs.
// Usage: node scripts/dev/shadcn-pull.mjs button card dialog …   (npm deps are printed, not installed)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STYLE = 'radix-nova';
const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const seen = new Set();
const npmDeps = new Set();

const ICON_LIBS = ['lucide', 'tabler', 'hugeicons', 'phosphor', 'remixicon'];

/** The CLI swaps <IconPlaceholder lucide="X" …/> for the chosen icon library (lucide here). */
function resolveIcons(content) {
  const used = new Set();
  let out = content.replace(/<IconPlaceholder([\s\S]*?)\/>/g, (_, attrs) => {
    const name = attrs.match(/lucide="([A-Za-z0-9]+)"/)?.[1];
    if (!name) throw new Error('IconPlaceholder without a lucide icon');
    used.add(name);
    const rest = attrs.replace(new RegExp(`\\s*(${ICON_LIBS.join('|')})="[^"]*"`, 'g'), '');
    return `<${name}${rest.trimEnd()} />`;
  });
  if (used.size) {
    out = out.replace(
      /import \{ IconPlaceholder \} from ["'][^"']+["']\n?/,
      `import { ${[...used].sort().join(', ')} } from "lucide-react"\n`,
    );
  }
  return out;
}

function rewrite(content) {
  return resolveIcons(content)
    .replace(/from ["']cn["']/g, 'from "@/lib/utils"')
    .replace(/@\/registry\/[a-z0-9-]+\/ui\//g, '@/components/ui/')
    .replace(/@\/registry\/[a-z0-9-]+\/hooks\//g, '@/hooks/')
    .replace(/@\/registry\/[a-z0-9-]+\/lib\//g, '@/lib/');
}

async function pull(name) {
  if (seen.has(name) || name === 'cn' || name === 'utils') return;
  seen.add(name);
  const res = await fetch(`https://ui.shadcn.com/r/styles/${STYLE}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const item = await res.json();
  for (const dep of item.dependencies ?? []) if (dep !== 'cn') npmDeps.add(dep);
  for (const file of item.files ?? []) {
    const base = file.path.split('/').at(-1);
    const folder = file.path.includes('/hooks/') ? 'src/hooks' : 'src/components/ui';
    const target = join(ROOT, folder, base);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewrite(file.content));
    console.log('wrote', `${folder}/${base}`);
  }
  for (const dep of item.registryDependencies ?? []) {
    await pull(
      dep
        .split('/')
        .at(-1)
        .replace(/\.json$/, ''),
    );
  }
}

for (const name of process.argv.slice(2)) await pull(name);
console.log('npm dependencies:', [...npmDeps].join(' ') || '(none)');

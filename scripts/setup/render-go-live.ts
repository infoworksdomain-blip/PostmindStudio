// Phase 19.2 — regenerate docs-site/go-live.html from runbooks/go-live.md:
//
//   npx tsx scripts/setup/render-go-live.ts
//
// Run it after every change to the guide; src/lib/setup/go-live-html.test.ts fails while the page
// is out of date.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGoLiveHtml } from '../../src/lib/setup/go-live-html';

const root = join(__dirname, '..', '..');
const html = renderGoLiveHtml(readFileSync(join(root, 'runbooks', 'go-live.md'), 'utf8'));
mkdirSync(join(root, 'docs-site'), { recursive: true });
writeFileSync(join(root, 'docs-site', 'go-live.html'), html);
process.stdout.write('Wrote docs-site/go-live.html\n');

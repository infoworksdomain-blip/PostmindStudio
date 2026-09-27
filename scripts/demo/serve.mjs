// Serves the demo build locally: node scripts/demo/serve.mjs [port] [file]
// The page is wrapped in a minimal HTML skeleton, as the artifact host does at publish time.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.argv[2] ?? 3020);
const file = process.argv[3]
  ? resolve(process.argv[3])
  : join(root, 'demo', 'dist', 'postmind-studio-demo.html');

createServer((req, res) => {
  if (req.url !== '/' && !req.url?.startsWith('/postmind-studio-demo.html')) {
    res.writeHead(404).end('Not found');
    return;
  }
  const page = readFileSync(file, 'utf8');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${page}</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`demo on http://127.0.0.1:${port}/\n`);
});

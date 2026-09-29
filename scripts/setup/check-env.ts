// Phase 19.2 — check a server settings file before a deploy (runbooks/go-live.md):
//
//   npm run setup:check -- <env file> [--backup <file>] [--legal-dir <dir>]
//
// Reports every required key as OK / MISSING / WRONG (with the reason) and the legal texts'
// readiness. Prints key names and reasons only, never a value. Exit 0 = ready, 1 = not ready,
// 2 = usage error.

import { join } from 'node:path';
import { runCheckEnv } from '../../src/lib/setup/cli';

runCheckEnv(process.argv.slice(2), {
  root: join(__dirname, '..', '..'),
  cwd: process.env.INIT_CWD ?? process.cwd(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);

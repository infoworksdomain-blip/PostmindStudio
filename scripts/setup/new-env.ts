// Phase 19.2 — write a fresh server settings file (runbooks/go-live.md step "Settings file"):
//
//   npm run setup:env -- --env production [--domain studio.example.com] [--out file] [--force]
//
// Writes <out> (default .secrets/<env>.env, git-ignored) from deploy/vps/.env.example with the
// random secrets generated, plus <env>.backup.env with the backup cipher passphrase. Refuses to
// replace an existing file without --force. Never prints a secret.

import { join } from 'node:path';
import { runNewEnv } from '../../src/lib/setup/cli';

const code = runNewEnv(process.argv.slice(2), {
  root: join(__dirname, '..', '..'),
  cwd: process.env.INIT_CWD ?? process.cwd(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exit(code);

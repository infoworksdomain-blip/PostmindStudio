// Phase 18 legal-readiness gate, for the launch checklist (runbooks/vps-deploy.md):
//
//   npx tsx scripts/legal/check-ready.ts            (reads content/legal or STUDIO_LEGAL_CONTENT_DIR)
//
// Lists every legal document that is missing or still the repository placeholder. Exits 1 while
// terms or privacy block public sign-up (and sign-up is not switched off), 0 otherwise.

import { legalReadiness, signupsState } from '../../src/lib/legal/readiness';
import { legalContentDir } from '../../src/lib/legal/documents';

async function main(): Promise<number> {
  const dir = legalContentDir();
  const readiness = await legalReadiness(dir);
  for (const doc of readiness.docs) {
    const state = !doc.present ? 'MISSING' : doc.placeholder ? 'PLACEHOLDER' : 'ok';
    process.stdout.write(`${state.padEnd(12)} ${doc.doc}\n`);
  }
  const signups = signupsState(readiness, { ...process.env, NODE_ENV: 'production' });
  if (!signups.open && signups.reason === 'legal_placeholder') {
    process.stderr.write(
      `Public sign-up stays closed in production until these are replaced: ${readiness.launchBlockers.join(', ')} (${dir})\n`,
    );
    return 1;
  }
  process.stdout.write(
    readiness.ready
      ? 'All legal documents are in place.\n'
      : 'Launch is not blocked, but some documents are still placeholders.\n',
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);

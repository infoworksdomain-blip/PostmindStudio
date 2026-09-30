// Phase 18 legal-readiness gate, for the launch checklist (runbooks/vps-deploy.md):
//
//   npx tsx scripts/legal/check-ready.ts            (reads content/legal or STUDIO_LEGAL_CONTENT_DIR)
//
// Lists every legal document that is missing, still the repository placeholder, or (Phase 20.4)
// a draft whose [[…]] fill-in markers are not filled in yet (content/legal/FILL-IN.md). Exits 1
// while terms or privacy block public sign-up (and sign-up is not switched off), 0 otherwise.

import { legalReadiness, signupsState, unfilledAcross } from '../../src/lib/legal/readiness';
import { legalContentDir } from '../../src/lib/legal/documents';

const LABEL = { missing: 'MISSING', placeholder: 'PLACEHOLDER', fill_in: 'FILL-IN', ready: 'ok' };

async function main(): Promise<number> {
  const dir = legalContentDir();
  const readiness = await legalReadiness(dir);
  for (const doc of readiness.docs) {
    const detail = doc.unfilled.length > 0 ? `  (${doc.unfilled.join(' ')})` : '';
    process.stdout.write(`${LABEL[doc.state].padEnd(12)} ${doc.doc}${detail}\n`);
  }
  const markers = unfilledAcross(readiness);
  if (markers.length > 0)
    process.stdout.write(
      `Fill in the [[…]] details (${markers.length} markers; where to find each value: content/legal/FILL-IN.md), then have a solicitor review the texts.\n`,
    );
  const signups = signupsState(readiness, { ...process.env, NODE_ENV: 'production' });
  if (!signups.open && signups.reason === 'legal_placeholder') {
    process.stderr.write(
      `Public sign-up stays closed in production until these are finished: ${readiness.launchBlockers.join(', ')} (${dir})\n`,
    );
    return 1;
  }
  process.stdout.write(
    readiness.ready
      ? 'All legal documents are in place.\n'
      : 'Launch is not blocked, but some documents are not finished yet.\n',
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

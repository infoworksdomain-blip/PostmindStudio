// BACKLOG 16.1 — machine-written UI copy must be reviewed by a native speaker before launch.
// npx tsx scripts/i18n/review-list.ts rewrites messages/<locale>.review.json for every non-source
// locale: keys already marked reviewed stay in `reviewed`, every other key is in `needs_review`.
// Run it after adding or changing keys; a reviewer moves keys from needs_review to reviewed.

import { writeFileSync } from 'node:fs';
import { buildReviewList } from '../../src/lib/i18n/catalogue-check';
import { readCatalogue, readReviewList, reviewPath, TRANSLATED_LOCALES } from './catalogues';

for (const locale of TRANSLATED_LOCALES) {
  const list = buildReviewList(locale, readCatalogue(locale), readReviewList(locale));
  writeFileSync(reviewPath(locale), `${JSON.stringify(list, null, 2)}\n`);
  process.stdout.write(
    `${locale}: ${list.needs_review.length} to review, ${list.reviewed.length} reviewed\n`,
  );
}

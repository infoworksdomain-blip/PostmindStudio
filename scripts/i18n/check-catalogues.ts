// BACKLOG 16.4 — catalogue check: npx tsx scripts/i18n/check-catalogues.ts
// Fails (exit 1) when a locale misses a key present in en-GB or has extra keys, a value is not
// valid ICU, arguments differ from en-GB, a plural lacks its locale's categories, or a
// machine-written catalogue has keys missing from its review list. `npm test` runs the same
// checks (test/unit/i18n-catalogues.test.ts).

import { checkCatalogue, checkReviewList } from '../../src/lib/i18n/catalogue-check';
import { DEFAULT_LOCALE, LOCALES } from '../../src/lib/i18n/locales';
import { readCatalogue, readReviewList, TRANSLATED_LOCALES } from './catalogues';

const source = readCatalogue(DEFAULT_LOCALE);
const problems = LOCALES.flatMap((locale) => {
  const catalogue = readCatalogue(locale);
  const found = checkCatalogue(locale, catalogue, source);
  return TRANSLATED_LOCALES.includes(locale)
    ? [...found, ...checkReviewList(locale, catalogue, readReviewList(locale))]
    : found;
});

for (const p of problems) process.stdout.write(`${p.locale}  ${p.kind}  ${p.key}: ${p.detail}\n`);
process.stdout.write(
  problems.length
    ? `\n${problems.length} catalogue problem(s)\n`
    : `catalogues OK (${LOCALES.length} locales)\n`,
);
process.exit(problems.length ? 1 : 0);

import {
  categoryDistribution,
  parseManifest,
  validateRows,
  type RowError,
} from './corpus-manifest';

// Phase 19 Track 1 — checks a generated manifest with the same parser and validator that
// scripts/ops/ingest-corpus.ts uses, and compares it with the upload list.

export interface ManifestCheck {
  rows: number;
  valid: number;
  errors: RowError[];
  distribution: Array<[string, number]>;
  withLanguage: number;
  withPlatform: number;
}

export function checkManifest(csv: string, categories: ReadonlySet<string>): ManifestCheck {
  const parsed = parseManifest(csv, 'csv');
  const { valid, errors } = validateRows(parsed.rows, categories);
  return {
    rows: parsed.rows.length + parsed.errors.length,
    valid: valid.length,
    errors: [...parsed.errors, ...errors].sort((a, b) => a.line - b.line),
    distribution: categoryDistribution(valid),
    withLanguage: valid.filter((r) => r.language).length,
    withPlatform: valid.filter((r) => r.sourcePlatform).length,
  };
}

export function formatManifestCheck(check: ManifestCheck, limit = 50): string {
  const lines = [
    `Validator (same as ingest-corpus.ts): ${check.valid} of ${check.rows} rows valid.`,
    'Category from the folder names (the rest are classified by Claude at ingest):',
    ...check.distribution.map(([cat, n]) => `    ${cat}: ${n}`),
    `Language set on ${check.withLanguage} rows, platform on ${check.withPlatform} rows.`,
  ];
  if (check.errors.length > 0) {
    lines.push(`Rejected rows (${check.errors.length}): fix these before the ingest.`);
    for (const e of check.errors.slice(0, limit))
      lines.push(`    line ${e.line}: ${e.error}${e.url ? ` (${e.url})` : ''}`);
    if (check.errors.length > limit) lines.push(`    … and ${check.errors.length - limit} more`);
  }
  return lines.join('\n');
}

/** Rows whose file was not uploaded, and uploaded files that have no row. */
export function compareWithUploadList(
  manifestPaths: readonly string[],
  uploadList: readonly string[],
): { notUploaded: string[]; notInManifest: string[] } {
  const uploaded = new Set(uploadList);
  const listed = new Set(manifestPaths);
  return {
    notUploaded: manifestPaths.filter((p) => !uploaded.has(p)),
    notInManifest: uploadList.filter((p) => !listed.has(p)),
  };
}

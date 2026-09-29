// The six legal documents (src/lib/legal/documents.ts LEGAL_DOCS) with their catalogue keys
// (legal.docs.*). Kept here, free of node:fs, so client bundles and the demo can import it.

export const LEGAL_DOC_KEYS = [
  { doc: 'terms', key: 'terms' },
  { doc: 'privacy', key: 'privacy' },
  { doc: 'cookies', key: 'cookies' },
  { doc: 'acceptable-use', key: 'acceptableUse' },
  { doc: 'dpa', key: 'dpa' },
  { doc: 'subprocessors', key: 'subprocessors' },
] as const;

export type LegalDocSlug = (typeof LEGAL_DOC_KEYS)[number]['doc'];
export type LegalDocKey = (typeof LEGAL_DOC_KEYS)[number]['key'];

export function legalDocKey(doc: string): LegalDocKey | null {
  return LEGAL_DOC_KEYS.find((d) => d.doc === doc)?.key ?? null;
}

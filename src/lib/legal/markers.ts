// Phase 20.4 — the two ways a legal document can still be unfinished. Pure string checks with no
// Node imports, so the static demo bundle (demo/public-pages.tsx) can share them with the app.
//
//   - PLACEHOLDER_MARKER: the repository placeholder the operator must replace entirely.
//   - Fill-in markers such as [[COMPANY LEGAL NAME]]: the shipped drafts are real text, but the
//     operator's own details (company name, number, address, contacts) are still missing. Listed
//     in content/legal/FILL-IN.md.
// Either one keeps the document "not ready": the page shows a banner, the Admin Centre warns and,
// for terms and privacy, production sign-up stays closed (readiness.ts).

/** Present in every placeholder file; the operator's real text must not contain it. */
export const PLACEHOLDER_MARKER = 'OPERATOR MUST REPLACE';

/** A fill-in marker: two square brackets around 1–80 characters on one line, e.g. [[CONTACT EMAIL]]. */
const FILL_IN_MARKER = /\[\[[^[\]\n]{1,80}\]\]/g;

/** The distinct fill-in markers still in the text, in order of first appearance. */
export function unfilledMarkers(markdown: string): string[] {
  return [...new Set(markdown.match(FILL_IN_MARKER) ?? [])];
}

export type LegalTextState = 'placeholder' | 'fill_in' | 'ready';

/** placeholder wins over fill_in: a placeholder file must be replaced, not filled in. */
export function legalTextState(markdown: string): LegalTextState {
  if (markdown.includes(PLACEHOLDER_MARKER)) return 'placeholder';
  return unfilledMarkers(markdown).length > 0 ? 'fill_in' : 'ready';
}

/** Not yet the operator's finished text: the placeholder, or a draft with fill-in markers left. */
export function isPlaceholder(markdown: string): boolean {
  return legalTextState(markdown) !== 'ready';
}

// Phase 19 (Phase 18 review, LOW): links in the operator's legal Markdown may only be http(s),
// mailto or relative. Anything else (tel:, data:, javascript:, ftp:, a scheme-relative //host,
// or a scheme hidden behind whitespace or control characters) is rendered as plain text.

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** The href to render, or null when the link must be shown as plain text. */
export function safeLegalHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null;
  // Browsers drop ASCII whitespace and control characters inside a URL scheme ("java\tscript:").
  const compact = href.replace(/[\u0000- \u007f]/g, '');
  if (compact === '') return null;
  // Scheme-relative (//host) and backslash forms (/\host, \\host) leave the site: not relative.
  if (/^[\\/][\\/]/.test(compact)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return href.trim(); // relative: /path, #anchor, ?query, ./x, ../x, page
  return ALLOWED_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`) ? href.trim() : null;
}

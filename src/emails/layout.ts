// The one layout every Studio email uses, as an HTML part and a plain-text part. Decision
// (Track B, 2026-09-29): plain TypeScript instead of React Email components — the templates are
// a heading, paragraphs, one button and a footer, and rendering with react-dom/server inside
// Next.js route bundles (React Server Components) is not supported. Every value is escaped here;
// callers pass plain text (ICU output) and absolute http(s) URLs only.
//
// Email clients ignore most CSS, so styles are inline and the structure is a table. Direction
// comes from the `dir` attribute (ar is RTL); no left/right alignment is set anywhere, so text
// follows the document direction.

export interface EmailLayout {
  locale: string;
  dir: 'ltr' | 'rtl';
  subject: string;
  brand: string;
  /** 26.2: absolute URL of the hosted logo (APP_URL/brand/logo-light.png); text brand without it. */
  logoUrl?: string;
  greeting: string;
  heading: string;
  /** Plain text; blank lines separate paragraphs. */
  body: string;
  cta?: { label: string; url: string; fallback: string };
  note?: string;
  signOff: string;
  footer: string[];
  unsubscribe?: { label: string; url: string };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const FONT = "-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Arabic',Arial,sans-serif";
const P_STYLE = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2933;';
const SMALL_STYLE = 'margin:0 0 8px;font-size:12px;line-height:1.5;color:#6b7280;';

/** The logo as an <img> (alt = the brand name, so blocked images still read as text). */
export function brandHtml({ brand, logoUrl }: { brand: string; logoUrl?: string }): string {
  if (!logoUrl) return escapeHtml(brand);
  return `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brand)}" width="120" height="40" style="display:block;border:0;outline:none;width:120px;height:40px;">`;
}

export function renderHtml(layout: EmailLayout): string {
  const p = (text: string, style = P_STYLE) =>
    `<p style="${style}">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  const cta = layout.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:6px;background:#111827;">` +
      `<a href="${escapeHtml(layout.cta.url)}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(layout.cta.label)}</a>` +
      `</td></tr></table>` +
      p(layout.cta.fallback, SMALL_STYLE) +
      `<p style="${SMALL_STYLE}word-break:break-all;"><a href="${escapeHtml(layout.cta.url)}" style="color:#374151;">${escapeHtml(layout.cta.url)}</a></p>`
    : '';
  const unsubscribe = layout.unsubscribe
    ? `<p style="${SMALL_STYLE}"><a href="${escapeHtml(layout.unsubscribe.url)}" style="color:#6b7280;">${escapeHtml(layout.unsubscribe.label)}</a></p>`
    : '';
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(layout.locale)}" dir="${layout.dir}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="color-scheme" content="light"><title>${escapeHtml(layout.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f3f4f6;font-family:${FONT};" dir="${layout.dir}">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;"><tr><td style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;">',
    `<tr><td style="padding:24px 28px 0;font-size:14px;font-weight:700;color:#111827;">${brandHtml(layout)}</td></tr>`,
    '<tr><td style="padding:16px 28px 8px;">',
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(layout.heading)}</h1>`,
    p(layout.greeting),
    ...paragraphs(layout.body).map((text) => p(text)),
    cta,
    layout.note ? p(layout.note, SMALL_STYLE) : '',
    p(layout.signOff),
    '</td></tr>',
    '<tr><td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;">',
    ...layout.footer.map((line) => p(line, SMALL_STYLE)),
    unsubscribe,
    '</td></tr></table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');
}

export function renderText(layout: EmailLayout): string {
  const blocks: string[] = [layout.heading, layout.greeting, ...paragraphs(layout.body)];
  if (layout.cta) blocks.push(`${layout.cta.label}: ${layout.cta.url}`);
  if (layout.note) blocks.push(layout.note);
  blocks.push(layout.signOff);
  blocks.push(['--', ...layout.footer].join('\n'));
  if (layout.unsubscribe) blocks.push(`${layout.unsubscribe.label}: ${layout.unsubscribe.url}`);
  return `${blocks.join('\n\n')}\n`;
}

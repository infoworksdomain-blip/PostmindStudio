import Link from 'next/link';
import { Construction, Languages } from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import { useTranslations } from 'next-intl';
import { LEGAL_DOC_KEYS, type LegalDocKey } from './legal-doc-keys';
import { safeLegalHref } from './legal-links';

// Phase 18 §3 /legal/<doc> — the operator's Markdown, rendered with react-markdown. Raw HTML in
// the file is skipped (skipHtml), so the placeholder marker comment never shows and nothing in
// the file can inject markup. A banner marks the repository placeholder; a note marks an
// English fallback for a locale without its own file.

const components: Components = {
  h1: ({ children }) => (
    <h1 className="font-display text-5xl leading-none md:text-6xl">{children}</h1>
  ),
  h2: ({ children }) => <h2 className="mt-10 font-display text-3xl">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-8 text-lg font-semibold">{children}</h3>,
  p: ({ children }) => <p className="mt-4 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="mt-4 list-disc space-y-1.5 ps-6">{children}</ul>,
  ol: ({ children }) => <ol className="mt-4 list-decimal space-y-1.5 ps-6">{children}</ol>,
  // Only http(s), mailto and relative links; anything else is plain text (legal-links.ts).
  a: ({ href, children }) => {
    const safe = safeLegalHref(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a
        href={safe}
        className="text-primary underline underline-offset-4"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border px-3 py-2 text-start">{children}</th>,
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-4 border-s-2 border-primary ps-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
};

export function LegalDocumentView({
  docKey,
  markdown,
  placeholder,
  fallback,
}: {
  docKey: LegalDocKey;
  markdown: string;
  placeholder: boolean;
  fallback: boolean;
}) {
  const t = useTranslations('legal');
  return (
    <div className="grid gap-12 py-12 lg:grid-cols-[14rem_1fr] lg:py-16">
      <nav aria-label={t('navAria')} className="lg:sticky lg:top-24 lg:self-start">
        <p className="mb-3 text-xs tracking-[0.2em] text-muted-foreground uppercase">
          {t('navTitle')}
        </p>
        <ul className="grid gap-1 text-sm">
          {LEGAL_DOC_KEYS.map(({ doc, key }) => (
            <li key={doc}>
              <Link
                href={`/legal/${doc}`}
                aria-current={key === docKey ? 'page' : undefined}
                className={
                  key === docKey
                    ? 'block rounded-md bg-accent px-3 py-1.5 font-medium'
                    : 'block rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground'
                }
              >
                {t(`docs.${key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="max-w-3xl min-w-0">
        {placeholder && (
          <div
            role="note"
            className="mb-8 flex gap-3 rounded-xl border border-warning/50 bg-warning/15 p-4 text-sm"
          >
            <Construction aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-semibold">{t('placeholder.title')}</p>
              <p className="mt-1 text-muted-foreground">{t('placeholder.body')}</p>
            </div>
          </div>
        )}
        {fallback && (
          <p role="note" className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Languages aria-hidden className="size-4" /> {t('notTranslated')}
          </p>
        )}
        <div lang={fallback ? 'en-GB' : undefined}>
          <Markdown skipHtml components={components}>
            {markdown}
          </Markdown>
        </div>
      </article>
    </div>
  );
}

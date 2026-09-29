import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { renderEmail, type RenderedEmail } from '@/emails/render';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { isLocale } from '@/lib/i18n/locales';
import { EMAIL_APP_URL, EMAIL_PREVIEWS, isPreviewTemplate } from './email-preview-data';
import { Panel, TourHeader } from './ui';

// #/tour/email/<template> — a transactional email as the worker renders it (src/emails/render.ts,
// the real template and catalogue) in the interface language, with sample parameters. Nothing is
// sent: this is what lands in the inbox.

// src/emails/params.ts measures the params with Buffer.byteLength (Node). The browser has no
// Buffer; the demo gives it the one method the check uses.
const g = globalThis as { Buffer?: { byteLength: (s: string, enc?: string) => number } };
g.Buffer ??= { byteLength: (s: string) => new TextEncoder().encode(s).length };

export function EmailPreview({ template }: { template: string }) {
  const locale = useLocale();
  const [email, setEmail] = useState<RenderedEmail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = isPreviewTemplate(template) ? EMAIL_PREVIEWS[template] : undefined;

  useEffect(() => {
    if (!preview || !isPreviewTemplate(template)) return;
    let alive = true;
    renderEmail({
      template,
      params: preview.params,
      locale,
      appUrl: EMAIL_APP_URL,
      supportEmail: 'support@leeds-sourdough.example',
      messages: (l) => Promise.resolve(ALL_MESSAGES[isLocale(l) ? l : 'en-GB']),
    })
      .then((out) => alive && setEmail(out))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [template, preview, locale]);

  return (
    <div lang="en" dir="ltr">
      <TourHeader
        eyebrow="Email preview · rendered by the real template"
        title={preview?.title ?? 'Email preview'}
        lede={
          <p>
            The email Studio sends, rendered in the interface language by the same code the worker
            uses (src/emails). Sample parameters; nothing is sent.
          </p>
        }
      >
        <nav aria-label="Other emails" className="mt-5 flex flex-wrap gap-1.5">
          {Object.entries(EMAIL_PREVIEWS).map(([key, p]) => (
            <a
              key={key}
              href={`#/tour/email/${key}`}
              aria-current={key === template ? 'page' : undefined}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground"
            >
              {p?.title}
            </a>
          ))}
        </nav>
      </TourHeader>
      {!preview && <p className="text-sm text-muted-foreground">No sample for “{template}”.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {email && (
        <Panel title={`Subject: ${email.subject}`} meta={`Language: ${email.locale}`}>
          <iframe
            title={`Email: ${email.subject}`}
            srcDoc={email.html}
            sandbox=""
            className="h-[34rem] w-full rounded-md border border-border bg-white"
          />
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Plain-text part</summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {email.text}
            </pre>
          </details>
        </Panel>
      )}
    </div>
  );
}

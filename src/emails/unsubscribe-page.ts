import { createTranslator } from 'next-intl';
import { directionOf, type Locale } from '../lib/i18n/locales';
import type { Messages } from '../lib/i18n/messages';
import { brandHtml, escapeHtml } from './layout';

// Phase 18 §2.8 — the small page behind the unsubscribe link (GET shows a confirm button, the
// POST applies it; RFC 8058 one-click POSTs from mail clients get a plain 200 instead). Server
// rendered, no script, localised from `email.unsubscribe.*`; the kind label is the one the
// notification preferences dialog shows (`shell.preferences.kinds.*`).

export type UnsubscribePageState = 'confirm' | 'done' | 'invalid';

export interface UnsubscribePage {
  state: UnsubscribePageState;
  locale: Locale;
  messages: Messages;
  /** The kind (confirm / done). */
  kind?: string;
  /** Relative form action carrying the token (confirm). */
  action?: string;
  appUrl: string;
}

type Loose = ((key: string, values?: Record<string, string>) => string) & {
  has(key: string): boolean;
};

export function renderUnsubscribePage(page: UnsubscribePage): string {
  const t = createTranslator({
    locale: page.locale,
    messages: page.messages as unknown as Record<string, unknown>,
  }) as unknown as Loose;
  const kindKey = `shell.preferences.kinds.${page.kind ?? ''}`;
  const kind = page.kind && t.has(kindKey) ? t(kindKey) : (page.kind ?? '');
  const heading =
    page.state === 'confirm'
      ? t('email.unsubscribe.confirmHeading')
      : page.state === 'done'
        ? t('email.unsubscribe.doneHeading')
        : t('email.unsubscribe.invalidHeading');
  const body =
    page.state === 'confirm'
      ? t('email.unsubscribe.confirmBody', { kind })
      : page.state === 'done'
        ? t('email.unsubscribe.doneBody', { kind })
        : t('email.unsubscribe.invalidBody');
  const action =
    page.state === 'confirm' && page.action
      ? `<form method="post" action="${escapeHtml(page.action)}"><button type="submit" style="padding:10px 18px;font-size:15px;font-weight:600;color:#fff;background:#111827;border:0;border-radius:6px;cursor:pointer;">${escapeHtml(t('email.unsubscribe.confirmButton'))}</button></form>`
      : `<p><a href="${escapeHtml(page.appUrl)}" style="color:#111827;">${escapeHtml(t('email.unsubscribe.openStudio'))}</a></p>`;
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(page.locale)}" dir="${directionOf(page.locale)}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(t('email.unsubscribe.pageTitle'))}</title></head>`,
    `<body style="margin:0;padding:32px 16px;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,'Noto Sans',Arial,sans-serif;color:#1f2933;">`,
    '<main style="max-width:520px;margin:0 auto;padding:28px;background:#fff;border-radius:8px;">',
    `<p style="margin:0 0 16px;font-size:14px;font-weight:700;">${brandHtml({ brand: t('email.layout.brand'), logoUrl: `${page.appUrl.replace(/\/+$/, '')}/brand/logo-light.png` })}</p>`,
    `<h1 style="margin:0 0 12px;font-size:22px;">${escapeHtml(heading)}</h1>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">${escapeHtml(body)}</p>`,
    action,
    '</main></body></html>',
  ].join('');
}

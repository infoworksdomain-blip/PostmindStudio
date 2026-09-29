import { createTranslator } from 'next-intl';
import { ConfigurationError } from '../lib/errors';
import { DEFAULT_LOCALE, directionOf, isLocale, type Locale } from '../lib/i18n/locales';
import { loadMessages, type Messages } from '../lib/i18n/messages';
import { isUntitledName } from '../lib/project-name';
import { TEMPLATES, type EmailTemplate } from './catalogue';
import { renderHtml, renderText, type EmailLayout } from './layout';
import { isHttpUrl, validateParams, type EmailParams } from './params';

// Phase 18 §2.8 — renders one email in the recipient's locale from messages/<locale>.json
// (`email.*`; the notification email also reads `notifications.*`, `format.platform.*` and
// `common.untitledVideo`, exactly as the in-app bell does, 16.5). A locale that is not one of the
// 11 falls back to en-GB, and so does a locale whose catalogue fails to format a message.

export interface RenderInput {
  template: EmailTemplate;
  params: EmailParams;
  /** The recipient's locale (users.locale); anything else falls back to en-GB. */
  locale: string | null | undefined;
  /** Public origin of Studio, for default button targets (`TemplateSpec.defaultPath`). */
  appUrl: string;
  /** STUDIO_SUPPORT_EMAIL, shown in the footer when set. */
  supportEmail?: string;
  /** Notification mail only: the signed one-click unsubscribe link. */
  unsubscribeUrl?: string;
  /** Catalogue loader (tests inject one); default loadMessages. */
  messages?: (locale: Locale) => Promise<Messages>;
}

export interface RenderedEmail {
  locale: Locale;
  subject: string;
  html: string;
  text: string;
}

type Values = Record<string, string | number | boolean | Date>;
interface LooseTranslator {
  (key: string, values?: Values): string;
  has(key: string): boolean;
}

function translatorFor(locale: Locale, messages: Messages): LooseTranslator {
  const errors: string[] = [];
  const t = createTranslator({
    locale,
    // The catalogue's static types would force literal keys; templates are chosen at run time.
    messages: messages as unknown as Record<string, unknown>,
    timeZone: 'UTC',
    onError: (err) => errors.push(err.message),
  }) as unknown as LooseTranslator;
  const strict = ((key: string, values?: Values) => {
    const text = t(key, values);
    if (errors.length > 0) {
      throw new ConfigurationError(`email message ${key} failed to format (${locale})`, {
        errors: errors.splice(0),
      });
    }
    return text;
  }) as LooseTranslator;
  strict.has = (key: string) => t.has(key);
  return strict;
}

/** ICU values: the template's date params become Date objects; null params are dropped. */
function toValues(template: EmailTemplate, params: EmailParams): Values {
  const dates = new Set(TEMPLATES[template].dates ?? []);
  const values: Values = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === null) continue;
    values[name] = dates.has(name) && typeof value === 'string' ? new Date(value) : value;
  }
  return values;
}

function absolute(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, '')}${path}`;
}

interface Content {
  subject: string;
  heading: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  note?: string;
}

function templateContent(t: LooseTranslator, input: RenderInput): Content {
  const { template, params } = input;
  const spec = TEMPLATES[template];
  const base = `email.templates.${template}`;
  const values = toValues(template, params);
  const url = isHttpUrl(params.url)
    ? params.url
    : spec.defaultPath
      ? absolute(input.appUrl, spec.defaultPath)
      : undefined;
  const hasCta = spec.cta !== false && url !== undefined && t.has(`${base}.cta`);
  return {
    subject: t(`${base}.subject`, values),
    heading: t(`${base}.heading`, values),
    body: t(`${base}.body`, values),
    ...(hasCta && { ctaLabel: t(`${base}.cta`, values), ctaUrl: url }),
    ...(t.has(`${base}.note`) && { note: t(`${base}.note`, values) }),
  };
}

/** Notification params stored by ResendEmailSender (lib/studio/notifications/resend-sender.ts). */
function notificationContent(t: LooseTranslator, input: RenderInput): Content {
  const { params } = input;
  const fallback = { title: String(params.subject ?? ''), body: String(params.text ?? '') };
  let text = fallback;
  const key = typeof params.messageKey === 'string' ? params.messageKey : undefined;
  if (key && t.has(`notifications.${key}.title`) && t.has(`notifications.${key}.body`)) {
    let messageParams: Values = {};
    try {
      const parsed: unknown =
        typeof params.messageParams === 'string' ? JSON.parse(params.messageParams) : {};
      if (parsed && typeof parsed === 'object') messageParams = { ...(parsed as Values) };
    } catch {
      messageParams = {};
    }
    const platform = messageParams.platform;
    if (typeof platform === 'string' && t.has(`format.platform.${platform}`)) {
      messageParams.platform = t(`format.platform.${platform}`);
    }
    if (typeof messageParams.name === 'string' && isUntitledName(messageParams.name)) {
      messageParams.name = t('common.untitledVideo');
    }
    try {
      text = {
        title: t(`notifications.${key}.title`, messageParams),
        body: t(`notifications.${key}.body`, messageParams),
      };
    } catch {
      // A parameter missing from the row: the stored English text is still correct.
      text = fallback;
    }
  }
  const link = isHttpUrl(params.link) ? params.link : undefined;
  return {
    subject: text.title,
    heading: text.title,
    body: text.body,
    ...(link && { ctaLabel: t('email.notification.cta'), ctaUrl: link }),
  };
}

function layoutFor(locale: Locale, messages: Messages, input: RenderInput): EmailLayout {
  const t = translatorFor(locale, messages);
  const content =
    input.template === 'notification' ? notificationContent(t, input) : templateContent(t, input);
  const name = typeof input.params.name === 'string' ? input.params.name.trim() : '';
  const category = TEMPLATES[input.template].category;
  const footer = [
    t(
      category === 'notification'
        ? 'email.layout.footerNotification'
        : 'email.layout.footerTransactional',
    ),
    ...(input.supportEmail ? [t('email.layout.support', { email: input.supportEmail })] : []),
  ];
  return {
    locale,
    dir: directionOf(locale),
    subject: content.subject,
    brand: t('email.layout.brand'),
    greeting: name ? t('email.layout.greeting', { name }) : t('email.layout.greetingAnonymous'),
    heading: content.heading,
    body: content.body,
    ...(content.ctaLabel &&
      content.ctaUrl && {
        cta: {
          label: content.ctaLabel,
          url: content.ctaUrl,
          fallback: t('email.layout.buttonFallback'),
        },
      }),
    ...(content.note && { note: content.note }),
    signOff: t('email.layout.signOff'),
    footer,
    ...(category === 'notification' &&
      input.unsubscribeUrl && {
        unsubscribe: { label: t('email.layout.unsubscribe'), url: input.unsubscribeUrl },
      }),
  };
}

export async function renderEmail(input: RenderInput): Promise<RenderedEmail> {
  validateParams(input.template, input.params);
  const load = input.messages ?? loadMessages;
  const wanted: Locale = isLocale(input.locale) ? input.locale : DEFAULT_LOCALE;
  const attempt = async (locale: Locale): Promise<RenderedEmail> => {
    const layout = layoutFor(locale, await load(locale), input);
    return { locale, subject: layout.subject, html: renderHtml(layout), text: renderText(layout) };
  };
  try {
    return await attempt(wanted);
  } catch (err) {
    if (wanted === DEFAULT_LOCALE || !(err instanceof ConfigurationError)) throw err;
    return attempt(DEFAULT_LOCALE);
  }
}

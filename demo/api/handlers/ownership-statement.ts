// 17.8 in the demo: the website-scan ownership statement is accepted only as an approved wording,
// exactly as services/approved-statements.ts does on the server. "Approved" = the text of
// business.scan.ownershipStatement in the catalogue shipped with the build (every catalogue is in
// the demo bundle). The object form { locale, messageKey, text? } is what the app sends; a plain
// string (the Phase 15/16 wire format) is accepted when it equals an approved text in some locale.
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { LOCALES, type Locale } from '@/lib/i18n/locales';
import { DemoHttpError } from '../registry';

export const OWNERSHIP_STATEMENT_KEY = 'business.scan.ownershipStatement';

export interface ApprovedStatement {
  locale: Locale;
  messageKey: typeof OWNERSHIP_STATEMENT_KEY;
  text: string;
}

const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** Comparison form: trimmed, NFC, runs of whitespace collapsed (normaliseStatement). */
const normalise = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

export function approvedStatement(locale: Locale): ApprovedStatement {
  return {
    locale,
    messageKey: OWNERSHIP_STATEMENT_KEY,
    text: ALL_MESSAGES[locale].business.scan.ownershipStatement,
  };
}

const invalid = (problem: string) =>
  new DemoHttpError(400, 'validation_error', 'Invalid request body', { problems: [problem] });

function refuse(): never {
  throw new DemoHttpError(
    400,
    'validation_error',
    'ownershipStatement does not match an approved version of the ownership statement',
    { code: 'statement_not_approved' },
  );
}

/** The approved { locale, messageKey, text } for the request field, or the server's 400. */
export function resolveOwnershipStatement(input: unknown): ApprovedStatement {
  if (typeof input === 'string') {
    const wanted = normalise(input);
    const hit = LOCALES.find((l) => normalise(approvedStatement(l).text) === wanted);
    return hit ? approvedStatement(hit) : refuse();
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw invalid(
      'ownershipStatement: ownershipStatement is required: send { locale, messageKey } of the checkbox text',
    );
  const { locale, messageKey, text } = input as Record<string, unknown>;
  if (!isLocale(locale))
    throw invalid(`ownershipStatement.locale: locale must be one of ${LOCALES.join(', ')}`);
  if (messageKey !== OWNERSHIP_STATEMENT_KEY)
    throw invalid(
      `ownershipStatement.messageKey: messageKey must be one of ${OWNERSHIP_STATEMENT_KEY}`,
    );
  const approved = approvedStatement(locale);
  if (
    text !== undefined &&
    (typeof text !== 'string' || normalise(text) !== normalise(approved.text))
  )
    refuse();
  return approved;
}

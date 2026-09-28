import { z } from 'zod';
import { ValidationError } from '../../errors';
import { LOCALES, type Locale } from '../../i18n/locales';
import { loadMessages } from '../../i18n/messages';

// BACKLOG 17.8 — statements a user agrees to are recorded as { locale, messageKey, text } and the
// text is the approved catalogue wording (messages/<locale>.json), never whatever a client sent.
//
// The website-scan ownership warranty (Addendum A6.7 / A11.2: "The checkbox text is preserved
// with the scan record for audit") is shown in the interface language since Phase 16. The server
// resolves the approved text for the locale and key and refuses anything else: a request may
// carry the text it showed (it must match exactly after trimming and Unicode NFC normalisation)
// or leave it out (the approved text is stored). Older clients that send only the text are
// accepted when it equals an approved version in some locale (that locale is recorded).
//
// "Approved versions" are the texts in the catalogues shipped with this build: a wording change
// is a catalogue change reviewed like any other, and the rows stored before it keep the text the
// user agreed to at the time.

/** Catalogue keys a user may agree to as a website ownership warranty. */
export const OWNERSHIP_STATEMENT_KEYS = ['business.scan.ownershipStatement'] as const;
export type OwnershipStatementKey = (typeof OWNERSHIP_STATEMENT_KEYS)[number];

/** Catalogue keys of voice-clone consent statements (parameterised; recorded, not matched). */
export const CONSENT_STATEMENT_KEYS = ['business.voice.cloneDialog.consentPhrase'] as const;

export const OWNERSHIP_STATEMENT_MAX = 1_000;

export interface ApprovedStatement {
  locale: Locale;
  messageKey: OwnershipStatementKey;
  text: string;
}

const localeSchema = z.enum(LOCALES, { error: `locale must be one of ${LOCALES.join(', ')}` });

/**
 * The request field. The object form is what the app sends; the string form is the Phase 15/16
 * wire format, still accepted when it is an approved text.
 */
export const ownershipStatementInput = z.union(
  [
    z
      .object({
        locale: localeSchema,
        messageKey: z.enum(OWNERSHIP_STATEMENT_KEYS, {
          error: `messageKey must be one of ${OWNERSHIP_STATEMENT_KEYS.join(', ')}`,
        }),
        /** The text the user was shown; optional — the server stores the approved text anyway. */
        text: z.string().trim().min(1).max(OWNERSHIP_STATEMENT_MAX).optional(),
      })
      .strict(),
    z.string().trim().min(10).max(OWNERSHIP_STATEMENT_MAX),
  ],
  { error: 'ownershipStatement is required: send { locale, messageKey } of the checkbox text' },
);

export type OwnershipStatementInput = z.infer<typeof ownershipStatementInput>;

/** Value at a dotted path of a catalogue, when it is a string. */
export function catalogueText(messages: unknown, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (
      typeof node !== 'object' ||
      node === null ||
      !Object.prototype.hasOwnProperty.call(node, part)
    )
      return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Comparison form: trimmed, NFC, runs of whitespace collapsed. */
export function normaliseStatement(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export async function approvedText(locale: Locale, key: OwnershipStatementKey): Promise<string> {
  const text = catalogueText(await loadMessages(locale), key);
  // Every locale has every key (scripts/i18n/check-catalogues.ts); a gap is a build defect.
  if (!text) throw new ValidationError(`No approved ${key} text for locale ${locale}`);
  return text;
}

function refuse(): never {
  throw new ValidationError(
    'ownershipStatement does not match an approved version of the ownership statement',
    { code: 'statement_not_approved' },
  );
}

/** Resolves the request field to the approved { locale, messageKey, text }, or refuses it. */
export async function resolveOwnershipStatement(
  input: OwnershipStatementInput,
): Promise<ApprovedStatement> {
  if (typeof input === 'string') {
    const wanted = normaliseStatement(input);
    for (const locale of LOCALES) {
      for (const messageKey of OWNERSHIP_STATEMENT_KEYS) {
        const text = await approvedText(locale, messageKey);
        if (normaliseStatement(text) === wanted) return { locale, messageKey, text };
      }
    }
    return refuse();
  }
  const text = await approvedText(input.locale, input.messageKey);
  if (input.text !== undefined && normaliseStatement(input.text) !== normaliseStatement(text))
    refuse();
  return { locale: input.locale, messageKey: input.messageKey, text };
}

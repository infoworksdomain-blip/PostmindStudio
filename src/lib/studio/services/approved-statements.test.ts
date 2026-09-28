import { describe, expect, it } from 'vitest';
import ar from '../../../../messages/ar.json';
import enGB from '../../../../messages/en-GB.json';
import enUS from '../../../../messages/en-US.json';
import zhHans from '../../../../messages/zh-Hans.json';
import { ValidationError } from '../../errors';
import { LOCALES } from '../../i18n/locales';
import {
  approvedText,
  catalogueText,
  normaliseStatement,
  ownershipStatementInput,
  resolveOwnershipStatement,
} from './approved-statements';

// BACKLOG 17.8 — the ownership statement is recorded as { locale, messageKey, text } and the text
// is the approved catalogue wording for that locale.

const KEY = 'business.scan.ownershipStatement' as const;

describe('catalogueText', () => {
  it('reads a dotted path and refuses anything that is not a string leaf', () => {
    expect(catalogueText(enGB, KEY)).toBe(enGB.business.scan.ownershipStatement);
    expect(catalogueText(enGB, 'business.scan')).toBeUndefined();
    expect(catalogueText(enGB, 'business.nope.ownershipStatement')).toBeUndefined();
    expect(catalogueText(enGB, 'toString')).toBeUndefined();
    expect(catalogueText(null, KEY)).toBeUndefined();
  });
});

describe('normaliseStatement', () => {
  it('trims, collapses whitespace and uses NFC', () => {
    expect(normaliseStatement('  a \n b  ')).toBe('a b');
    expect(normaliseStatement('é')).toBe('é');
  });
});

describe('approvedText', () => {
  it('has an approved text in every interface locale', async () => {
    for (const locale of LOCALES)
      expect((await approvedText(locale, KEY)).length).toBeGreaterThan(10);
  });
});

describe('ownershipStatementInput', () => {
  it('accepts { locale, messageKey, text? } and the legacy string; refuses unknown keys', () => {
    expect(ownershipStatementInput.safeParse({ locale: 'ar', messageKey: KEY }).success).toBe(true);
    expect(
      ownershipStatementInput.safeParse({ locale: 'fr', messageKey: KEY, text: 'x' }).success,
    ).toBe(true);
    expect(ownershipStatementInput.safeParse('I own this website, honestly.').success).toBe(true);
    expect(ownershipStatementInput.safeParse({ locale: 'xx', messageKey: KEY }).success).toBe(
      false,
    );
    expect(
      ownershipStatementInput.safeParse({ locale: 'fr', messageKey: 'business.scan.title' })
        .success,
    ).toBe(false);
    expect(
      ownershipStatementInput.safeParse({ locale: 'fr', messageKey: KEY, extra: 1 }).success,
    ).toBe(false);
    expect(ownershipStatementInput.safeParse(undefined).success).toBe(false);
    expect(ownershipStatementInput.safeParse('yes').success).toBe(false);
  });
});

describe('resolveOwnershipStatement', () => {
  it('stores the approved text for the locale and key (no text sent)', async () => {
    await expect(resolveOwnershipStatement({ locale: 'ar', messageKey: KEY })).resolves.toEqual({
      locale: 'ar',
      messageKey: KEY,
      text: ar.business.scan.ownershipStatement,
    });
  });

  it('accepts the shown text when it matches the approved one (whitespace-insensitive)', async () => {
    const text = zhHans.business.scan.ownershipStatement;
    await expect(
      resolveOwnershipStatement({ locale: 'zh-Hans', messageKey: KEY, text: ` ${text} ` }),
    ).resolves.toMatchObject({ locale: 'zh-Hans', text });
  });

  it('refuses a text that is not the approved wording for that locale', async () => {
    await expect(
      resolveOwnershipStatement({ locale: 'en-GB', messageKey: KEY, text: 'I promise.' }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The approved en-US wording is not the approved en-GB wording.
    await expect(
      resolveOwnershipStatement({
        locale: 'en-GB',
        messageKey: KEY,
        text: enUS.business.scan.ownershipStatement,
      }),
    ).rejects.toThrow('does not match an approved version');
  });

  it('accepts a legacy plain string only when it is an approved text, recording its locale', async () => {
    await expect(resolveOwnershipStatement(enUS.business.scan.ownershipStatement)).resolves.toEqual(
      { locale: 'en-US', messageKey: KEY, text: enUS.business.scan.ownershipStatement },
    );
    await expect(
      resolveOwnershipStatement(ar.business.scan.ownershipStatement),
    ).resolves.toMatchObject({ locale: 'ar' });
    await expect(
      resolveOwnershipStatement('I own or am authorised to represent this website.'),
    ).rejects.toThrow('does not match an approved version');
  });
});

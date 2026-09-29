import { describe, expect, it } from 'vitest';
import { safeLegalHref } from './legal-links';

describe('safeLegalHref', () => {
  it.each([
    ['https://example.com/terms', 'https://example.com/terms'],
    ['HTTP://EXAMPLE.COM', 'HTTP://EXAMPLE.COM'],
    ['mailto:legal@example.com', 'mailto:legal@example.com'],
    ['/legal/privacy', '/legal/privacy'],
    ['#section-2', '#section-2'],
    ['?lang=fr', '?lang=fr'],
    ['../cookies', '../cookies'],
    ['privacy', 'privacy'],
    ['  /padded  ', '/padded'],
  ])('keeps %s', (href, expected) => {
    expect(safeLegalHref(href)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    ' \u0001javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'tel:+441234567890',
    'ftp://example.com',
    'file:///etc/passwd',
    '//evil.example/x',
    '/\\evil.example',
    '\\\\evil.example',
    '',
    '   ',
    undefined,
    null,
  ])('drops %j', (href) => {
    expect(safeLegalHref(href)).toBeNull();
  });
});

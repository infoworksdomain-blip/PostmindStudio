import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../errors';
import { combineVerdicts, formatMarkdown, redactUrl, resultBaseName } from './report';

describe('resultBaseName', () => {
  it('names files by UTC date and check id', () => {
    expect(resultBaseName('k6-smoke', new Date('2026-09-28T23:30:00Z'))).toBe(
      'ops/results/2026-09-28-k6-smoke',
    );
    expect(resultBaseName('restore-check', new Date('2026-09-28T00:00:00Z'), 'out/')).toBe(
      'out/2026-09-28-restore-check',
    );
    expect(() => resultBaseName('../etc', new Date())).toThrow(ValidationError);
  });
});

describe('combineVerdicts', () => {
  it('lets FAIL win, then INCOMPLETE', () => {
    expect(combineVerdicts(['PASS', 'PASS'])).toBe('PASS');
    expect(combineVerdicts(['PASS', 'INCOMPLETE'])).toBe('INCOMPLETE');
    expect(combineVerdicts(['INCOMPLETE', 'FAIL'])).toBe('FAIL');
    expect(combineVerdicts([])).toBe('INCOMPLETE');
  });
});

describe('formatMarkdown', () => {
  it('renders the verdict, context and sections', () => {
    const md = formatMarkdown({
      check: 'k6-smoke',
      title: 'k6 smoke run (14.5)',
      verdict: 'PASS',
      startedAt: '2026-09-28T10:00:00Z',
      finishedAt: '2026-09-28T10:01:00Z',
      context: { Operator: 'amy', Note: 'a|b' },
      sections: [{ title: 'Thresholds', verdict: 'PASS', lines: ['all good'] }],
      data: {},
    });
    expect(md).toContain('# k6 smoke run (14.5)');
    expect(md).toContain('**Verdict: PASS**');
    expect(md).toContain('| Note | a\\|b |');
    expect(md).toContain('## Thresholds — PASS');
  });
});

describe('redactUrl', () => {
  it('removes credentials and secret query params', () => {
    expect(redactUrl('postgresql://user:pw@db.internal:5432/postgres?schema=studio')).toBe(
      'postgresql://***:***@db.internal:5432/postgres?schema=studio',
    );
    expect(redactUrl('https://s.example.com/x?token=abc&a=1')).toBe(
      'https://s.example.com/x?token=***&a=1',
    );
    expect(redactUrl('not a url')).toBe('<unparseable url>');
  });
});

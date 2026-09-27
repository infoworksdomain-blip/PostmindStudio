import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { formatRedriveReport, parseRedriveArgs } from './redrive-cli';

describe('parseRedriveArgs', () => {
  it('is a dry run unless --apply is given', () => {
    expect(parseRedriveArgs(['stuck'])).toEqual({ scope: 'stuck', dryRun: true });
    expect(parseRedriveArgs(['stuck', '--apply'])).toEqual({ scope: 'stuck', dryRun: false });
  });

  it('maps every option onto the request body', () => {
    expect(
      parseRedriveArgs([
        'kill_switch',
        '--since',
        '2026-09-27T09:00:00Z',
        '--level',
        'platform',
        '--org',
        'org_1',
        '--limit',
        '50',
        '--apply',
      ]),
    ).toEqual({
      scope: 'kill_switch',
      since: '2026-09-27T09:00:00Z',
      level: 'platform',
      organisationId: 'org_1',
      limit: 50,
      dryRun: false,
    });
    expect(parseRedriveArgs(['stuck', '--stuck-minutes', '45'])).toMatchObject({
      stuckMinutes: 45,
    });
  });

  it('rejects bad input', () => {
    expect(() => parseRedriveArgs([])).toThrow(ValidationError);
    expect(() => parseRedriveArgs(['everything'])).toThrow('kill_switch or stuck');
    expect(() => parseRedriveArgs(['kill_switch'])).toThrow('--since');
    expect(() => parseRedriveArgs(['stuck', '--limit'])).toThrow('needs a value');
    expect(() => parseRedriveArgs(['stuck', '--limit', 'ten'])).toThrow('whole number');
    expect(() => parseRedriveArgs(['stuck', '--force'])).toThrow('unknown option');
  });
});

describe('formatRedriveReport', () => {
  const report = {
    dryRun: true,
    scope: 'kill_switch',
    counts: { considered: 2, redriven: 1, skipped: 1 },
    items: [
      {
        kind: 'project',
        id: 'p1',
        organisationId: 'o1',
        action: 'resume_assets',
        jobs: ['generate-asset'],
      },
      {
        kind: 'publication',
        id: 'pub1',
        organisationId: 'o1',
        action: 'skipped',
        skippedReason: 'kill_switch_still_engaged: platform',
      },
    ],
  };

  it('labels a dry run and tells the operator how to apply', () => {
    const text = formatRedriveReport(report);
    expect(text).toContain('DRY RUN');
    expect(text).toContain('would re-drive 1, skipped 1');
    expect(text).toContain('resume_assets → generate-asset');
    expect(text).toContain('skipped: kill_switch_still_engaged: platform');
    expect(text).toContain('--apply');
  });

  it('reports an applied run without the hint', () => {
    const text = formatRedriveReport({ ...report, dryRun: false });
    expect(text).toContain('re-drove 1');
    expect(text).not.toContain('DRY RUN');
    expect(text).not.toContain('--apply');
  });
});

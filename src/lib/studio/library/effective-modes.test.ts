import { describe, expect, it } from 'vitest';
import { effectiveAllowedModes } from './blueprint';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const both = ['TEMPLATE', 'INSPIRE'];

describe('effectiveAllowedModes', () => {
  it('returns the licence modes while the licence is valid or has no expiry', () => {
    expect(effectiveAllowedModes({ allowedModes: both, licenseExpires: null }, NOW)).toEqual(both);
    expect(
      effectiveAllowedModes({ allowedModes: both, licenseExpires: new Date(NOW + 1000) }, NOW),
    ).toEqual(both);
  });

  it('keeps Inspire only for scraped references', () => {
    expect(effectiveAllowedModes({ allowedModes: ['INSPIRE'], licenseExpires: null }, NOW)).toEqual(
      ['INSPIRE'],
    );
  });

  it('offers nothing once the licence has expired', () => {
    expect(
      effectiveAllowedModes({ allowedModes: both, licenseExpires: new Date(NOW - 1) }, NOW),
    ).toEqual([]);
  });

  it('offers nothing without a licence row', () => {
    expect(effectiveAllowedModes(null, NOW)).toEqual([]);
  });
});

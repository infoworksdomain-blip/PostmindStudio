import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  formatCount,
  formatDate,
  formatDuration,
  formatPence,
  PLATFORM_LABEL,
  PROJECT_STATE,
  PUBLICATION_STATE,
  relativeTime,
  safeHttpUrl,
  stateOf,
} from './format';

describe('formatPence', () => {
  it('formats whole pounds', () => {
    expect(formatPence(150000)).toBe('£1,500.00');
  });

  it('formats pence into pounds and pence', () => {
    expect(formatPence(1099)).toBe('£10.99');
  });

  it('treats null and undefined as zero', () => {
    expect(formatPence(null)).toBe('£0.00');
    expect(formatPence(undefined)).toBe('£0.00');
  });

  it('formats zero', () => {
    expect(formatPence(0)).toBe('£0.00');
  });

  it('formats negative values (refunds)', () => {
    expect(formatPence(-500)).toBe('-£5.00');
  });
});

describe('formatCount', () => {
  it('formats small numbers without compaction', () => {
    expect(formatCount(42)).toBe('42');
  });

  it('compacts large numbers', () => {
    expect(formatCount(12500)).toBe('12.5k');
  });

  it('compacts millions', () => {
    expect(formatCount(2_400_000)).toBe('2.4m');
  });

  it('treats null and undefined as zero', () => {
    expect(formatCount(null)).toBe('0');
    expect(formatCount(undefined)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2:05');
  });

  it('formats hours, minutes and padded minutes', () => {
    expect(formatDuration(3725)).toBe('1h 02m');
  });

  it('treats null, undefined and negative values as zero', () => {
    expect(formatDuration(null)).toBe('0s');
    expect(formatDuration(undefined)).toBe('0s');
    expect(formatDuration(-10)).toBe('0s');
  });

  it('rounds fractional seconds', () => {
    expect(formatDuration(59.6)).toBe('1:00');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');

  it('returns an em dash placeholder for null or undefined', () => {
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime(undefined, now)).toBe('—');
  });

  it('formats a past time in the largest applicable unit', () => {
    const oneDayAgo = new Date(now - 26 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(oneDayAgo, now)).toMatch(/yesterday|1 day ago/);
  });

  it('formats a future time', () => {
    const inTwoHours = new Date(now + 2 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(inTwoHours, now)).toMatch(/in 2 hours/);
  });

  it('falls back to "just now" for sub-minute differences', () => {
    const secondsAgo = new Date(now - 5000).toISOString();
    expect(relativeTime(secondsAgo, now)).toBe('just now');
  });
});

describe('formatDate', () => {
  it('returns an em dash placeholder for null or undefined', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('formats a valid ISO date string', () => {
    const formatted = formatDate('2026-01-15T09:30:00Z');
    expect(formatted).toContain('2026');
  });
});

describe('stateOf', () => {
  it('returns the known label and tone for a mapped state', () => {
    expect(stateOf(PROJECT_STATE, 'APPROVED')).toEqual({ label: 'Approved', tone: 'good' });
  });

  it('falls back to a humanised label with neutral tone for an unknown state', () => {
    expect(stateOf(PROJECT_STATE, 'SOME_NEW_STATE')).toEqual({
      label: 'some new state',
      tone: 'neutral',
    });
  });

  it('works for the publication state map too', () => {
    expect(stateOf(PUBLICATION_STATE, 'PUBLISHED')).toEqual({ label: 'Live', tone: 'good' });
  });
});

describe('PLATFORM_LABEL', () => {
  it('has human-readable labels for every supported platform key', () => {
    expect(PLATFORM_LABEL.tiktok).toBe('TikTok');
    expect(PLATFORM_LABEL.youtube_short).toBe('YouTube Shorts');
  });
});

describe('safeHttpUrl', () => {
  it('returns null for null and undefined', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(safeHttpUrl('')).toBeNull();
  });

  it('allows https URLs', () => {
    expect(safeHttpUrl('https://www.instagram.com/p/abc123/')).toBe(
      'https://www.instagram.com/p/abc123/',
    );
  });

  it('allows http URLs', () => {
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('rejects javascript: URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects data: URLs', () => {
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects unparseable strings', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});

describe('ACTIVE_STATES', () => {
  it('contains only project states whose tone is "live"', () => {
    expect(ACTIVE_STATES.has('RENDERING')).toBe(true);
    expect(ACTIVE_STATES.has('QUEUED')).toBe(true);
    expect(ACTIVE_STATES.has('DRAFT')).toBe(false);
    expect(ACTIVE_STATES.has('PUBLISHED')).toBe(false);
  });
});

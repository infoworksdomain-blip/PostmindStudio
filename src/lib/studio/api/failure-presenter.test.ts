import { describe, expect, it } from 'vitest';
import { parseFailure, UNKNOWN_FAILURE } from '../../client/failure-reasons';
import { mayReadRawFailures, presentBody, redactFailureReason } from './failure-presenter';

const RAW = [
  'youtube_short/unavailable: connect ECONNREFUSED 10.0.0.1:443',
  'runway/provider_unavailable: upstream said {"error":"host 10.1.1.1"}',
  'openai/insufficient_credits: 429 You have no credits remaining.',
  'planning_failed: kill_switch_workspace: Studio kill switch active',
  'composition_failed: shotstack/rate_limited: Too Many Requests token=abc',
  'planning_failed: getaddrinfo ENOTFOUND api.internal.example',
  'asset_generation_failed: shot 2: runway/timeout: x; shot 4: luma/unknown: y',
  'quality_failed: tiktok/black_frames: 2 segments; youtube_short/audio_present: none',
  'scan_cost_cap: Stopped at the scan cost cap (50p)',
  'rejected: Please fix the logo',
  'cancelled_by_user',
];

describe('redactFailureReason', () => {
  it.each(RAW)('keeps what the sentence needs and drops provider text: %s', (raw) => {
    const before = parseFailure(raw);
    const after = parseFailure(redactFailureReason(raw));
    expect(after?.code).toBe(before?.code);
    expect(after?.params).toEqual(before?.params);
    expect(after?.cause?.code).toBe(before?.cause?.code);
    expect(redactFailureReason(raw)).not.toMatch(
      /ECONNREFUSED|10\.\d+\.\d+\.\d+|ENOTFOUND|token=|upstream said|no credits|Too Many/,
    );
  });

  it('keeps a reviewer note (customer text) and replaces an uncoded reason', () => {
    expect(redactFailureReason('rejected: Please fix the logo')).toBe(
      'rejected: Please fix the logo',
    );
    expect(redactFailureReason('getaddrinfo ENOTFOUND x')).toBe(UNKNOWN_FAILURE);
  });
});

describe('presentBody', () => {
  const body = {
    project: {
      errorReason: 'runway/unavailable: host 10.0.0.1',
      shots: [{ errorReason: 'x boom' }],
    },
    scan: { robotsBlocked: false, errors: ['connect ECONNREFUSED'], errorReason: null },
    other: { errors: ['not a scan, left alone'] },
  };

  it('redacts errorReason everywhere and scan errors for a customer', () => {
    const out = presentBody(body, { platformRole: 'user' });
    expect(JSON.stringify(out)).not.toMatch(/10\.0\.0\.1|boom|ECONNREFUSED/);
    expect(out.other.errors).toEqual(['not a scan, left alone']);
    expect(out.scan.errorReason).toBeNull();
  });

  it('keeps Dates and other class instances intact (they serialise themselves)', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    const out = presentBody(
      { publication: { scheduledFor: at, errorReason: 'x' } },
      { platformRole: 'user' },
    );
    expect(out.publication.scheduledFor).toBe(at);
    expect(JSON.parse(JSON.stringify(out)).publication.scheduledFor).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('leaves the body alone for platform staff; core-mode callers count as customers', () => {
    expect(presentBody(body, { platformRole: 'staff' })).toBe(body);
    expect(mayReadRawFailures({ platformRole: 'superadmin' })).toBe(true);
    expect(mayReadRawFailures({})).toBe(false);
  });
});

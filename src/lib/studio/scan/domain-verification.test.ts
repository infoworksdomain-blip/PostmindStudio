import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../tenant';
import {
  checkTxtRecord,
  normaliseDomain,
  recordName,
  requireEnterprise,
  VALUE_PREFIX,
} from './domain-verification';

const tenant = (planTier?: string): TenantContext => ({
  userId: 'u',
  organisationId: 'o',
  organisation: { id: 'o', planTier },
  memberships: [],
  capabilities: [],
});

describe('normaliseDomain', () => {
  it('accepts host names, URLs and www., lower-cased', () => {
    expect(normaliseDomain('LeedsSourdough.co.uk')).toBe('leedssourdough.co.uk');
    expect(normaliseDomain('https://www.leedssourdough.co.uk/about?x=1')).toBe(
      'leedssourdough.co.uk',
    );
    expect(normaliseDomain('shop.example.com.')).toBe('shop.example.com');
  });

  it('refuses IPs, single labels, bad labels and junk', () => {
    for (const bad of ['192.168.0.1', 'localhost', '-bad.com', 'a..b', 'exa mple.com', 'http://']) {
      expect(() => normaliseDomain(bad)).toThrow('host name');
    }
    expect(() => normaliseDomain(`${'a'.repeat(64)}.com`)).toThrow();
  });
});

describe('requireEnterprise', () => {
  it('allows ENTERPRISE only', () => {
    expect(() => requireEnterprise(tenant('ENTERPRISE'))).not.toThrow();
    expect(() => requireEnterprise(tenant('PLUS'))).toThrow('Enterprise');
    expect(() => requireEnterprise(tenant(undefined))).toThrow('Enterprise');
  });
});

describe('checkTxtRecord', () => {
  const token = 'abc123';

  it('looks up _postmind-studio.<domain> and joins split strings', async () => {
    const asked: string[] = [];
    const result = await checkTxtRecord(
      async (host) => {
        asked.push(host);
        return [['v=spf1 -all'], ['pm-studio-verify=', 'abc123']];
      },
      'bakery.example',
      token,
    );
    expect(asked).toEqual([recordName('bakery.example')]);
    expect(asked[0]).toBe('_postmind-studio.bakery.example');
    expect(result).toEqual({ found: true, error: null });
  });

  it('reports a wrong value, a missing record and a DNS failure', async () => {
    expect(
      (await checkTxtRecord(async () => [[`${VALUE_PREFIX}other`]], 'b.example', token)).found,
    ).toBe(false);
    const missing = await checkTxtRecord(
      async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      },
      'b.example',
      token,
    );
    expect(missing).toEqual({ found: false, error: 'No TXT record yet' });
    const failed = await checkTxtRecord(
      async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
      'b.example',
      token,
    );
    expect(failed.error).toContain('ETIMEOUT');
  });
});

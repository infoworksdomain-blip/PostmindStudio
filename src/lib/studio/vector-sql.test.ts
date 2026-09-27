import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../errors';
import { vectorSql, vectorSqlFor, type RawQueryClient } from './vector-sql';

const client = (impl: () => Promise<unknown>): RawQueryClient & { calls: () => number } => {
  const fn = vi.fn(impl);
  return {
    $queryRaw: fn as unknown as RawQueryClient['$queryRaw'],
    calls: () => fn.mock.calls.length,
  };
};

describe('vectorSqlFor', () => {
  it('qualifies the cast and the cosine operator with the schema', () => {
    const v = vectorSqlFor('public');
    expect(v.cast.sql).toBe('::"public".vector');
    expect(v.distance.sql).toBe('OPERATOR("public".<=>)');
  });

  it('refuses anything but a plain identifier', () => {
    expect(() => vectorSqlFor('public"; DROP TABLE x; --')).toThrow(ConfigurationError);
    expect(() => vectorSqlFor('')).toThrow(ConfigurationError);
  });
});

describe('vectorSql', () => {
  it('looks the schema up once per client', async () => {
    const db = client(async () => [{ schema: 'studio' }]);
    expect((await vectorSql(db)).schema).toBe('studio');
    expect((await vectorSql(db)).schema).toBe('studio');
    expect(db.calls()).toBe(1);
  });

  it('reports a missing extension as a configuration error', async () => {
    await expect(vectorSql(client(async () => []))).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('does not cache a failed lookup', async () => {
    let fail = true;
    const db = client(async () => {
      if (fail) throw new Error('db down');
      return [{ schema: 'public' }];
    });
    await expect(vectorSql(db)).rejects.toThrow('db down');
    fail = false;
    expect((await vectorSql(db)).schema).toBe('public');
  });
});

import { describe, expect, it } from 'vitest';
import { mergeLeaves } from '../../scripts/i18n/merge-keys';

describe('merge-keys (leaf-level catalogue merge)', () => {
  it('adds new leaves and namespaces without touching existing keys or their order', () => {
    const catalogue = { common: { save: 'Save' }, auth: { title: 'Sign in' } };
    const result = mergeLeaves(catalogue, {
      auth: { subtitle: 'Welcome back', title: 'Sign in' },
      billing: {},
    });
    expect(catalogue).toEqual({
      common: { save: 'Save' },
      auth: { title: 'Sign in', subtitle: 'Welcome back' },
      billing: {},
    });
    expect(Object.keys(catalogue)).toEqual(['common', 'auth', 'billing']);
    expect(result).toEqual({ added: ['auth.subtitle', 'billing'], changed: [], conflicts: [] });
  });

  it('never overwrites a different existing message unless asked', () => {
    const catalogue = { auth: { title: 'Sign in' } };
    expect(mergeLeaves(catalogue, { auth: { title: 'Log in' } }).conflicts).toHaveLength(1);
    expect(catalogue.auth.title).toBe('Sign in');
    expect(
      mergeLeaves(catalogue, { auth: { title: 'Log in' } }, { overwrite: true }).changed,
    ).toEqual(['auth.title']);
    expect(catalogue.auth.title).toBe('Log in');
  });

  it('reports shape conflicts instead of replacing a namespace', () => {
    const catalogue = { auth: { title: 'Sign in' } };
    const result = mergeLeaves(catalogue, { auth: 'flat' as never });
    expect(result.conflicts).toEqual(['auth (an object, not a message)']);
    expect(catalogue.auth).toEqual({ title: 'Sign in' });
  });
});

import { describe, expect, it } from 'vitest';
import { deploymentId } from './deployment-id';

describe('deploymentId', () => {
  it('uses the commit SHA the image build passes', () => {
    expect(deploymentId('  fe1abeaa87706cf43f173acd9149c94ab7312162 ')).toBe(
      'fe1abeaa87706cf43f173acd9149c94ab7312162',
    );
  });

  it('is off (undefined) when unset or blank, as in local builds and tests', () => {
    expect(deploymentId(undefined)).toBeUndefined();
    expect(deploymentId('')).toBeUndefined();
    expect(deploymentId('   ')).toBeUndefined();
  });
});

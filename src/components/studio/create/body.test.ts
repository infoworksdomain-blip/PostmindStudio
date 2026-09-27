import { describe, expect, it } from 'vitest';
import { buildCreateBody, parseReference, validateCreate, type CreateState } from './body';

const base: CreateState = {
  brief: 'Spring menu',
  source: 'BRIEF',
  platforms: ['tiktok'],
  length: 'short',
  brandKitId: null,
  templateId: null,
  targetAudience: '',
  callToAction: '',
  budgetPounds: '',
  reviewPolicy: '',
};

describe('validateCreate', () => {
  it('accepts the defaults with a brief', () => {
    expect(validateCreate(base, 'biz')).toEqual([]);
  });

  it('lists every blocking problem', () => {
    const problems = validateCreate(
      { ...base, brief: ' ', platforms: [], source: 'SLIDESHOW', budgetPounds: 'abc' },
      null,
    );
    expect(problems).toHaveLength(5);
  });
});

describe('buildCreateBody', () => {
  it('includes brief hints only when given', () => {
    const body = buildCreateBody(
      { ...base, targetAudience: ' Locals ', callToAction: 'Book now' },
      'biz',
      null,
    );
    expect(body.brief).toEqual({
      rawInput: 'Spring menu',
      targetAudience: 'Locals',
      callToAction: 'Book now',
    });
  });

  it('ignores a reference for slideshows', () => {
    const body = buildCreateBody({ ...base, source: 'SLIDESHOW', templateId: 't1' }, 'biz', {
      id: 'lib',
      mode: 'TEMPLATE',
    });
    expect(body.sourceType).toBe('SLIDESHOW');
    expect(body.referenceVideoId).toBeUndefined();
  });
});

describe('parseReference', () => {
  it('defaults to INSPIRE and rejects malformed ids', () => {
    expect(parseReference('lib_1', undefined)).toEqual({ id: 'lib_1', mode: 'INSPIRE' });
    expect(parseReference('lib_1', 'template')).toEqual({ id: 'lib_1', mode: 'TEMPLATE' });
    expect(parseReference('../x', 'TEMPLATE')).toBeNull();
    expect(parseReference(undefined, undefined)).toBeNull();
  });
});

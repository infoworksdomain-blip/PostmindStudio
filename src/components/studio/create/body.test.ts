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
  projectTemplate: null,
  autoPublish: false,
  autoPublishAccounts: {},
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

describe('templates and auto-publish', () => {
  const template = {
    id: 'tpl-1',
    name: 'Introduce yourself',
    platforms: ['tiktok', 'instagram_reel'],
  };

  it('builds a TEMPLATE project without formats; the brief is optional', () => {
    const body = buildCreateBody({ ...base, brief: '', projectTemplate: template }, 'biz', null);
    expect(body).toMatchObject({
      sourceType: 'TEMPLATE',
      templateId: 'tpl-1',
      name: 'Introduce yourself',
    });
    expect(body.targetFormats).toBeUndefined();
    expect(body.brief).toBeUndefined();
    expect(
      validateCreate({ ...base, brief: '', platforms: [], projectTemplate: template }, 'biz'),
    ).toEqual([]);
  });

  it('a library reference wins over a template', () => {
    const body = buildCreateBody({ ...base, projectTemplate: template }, 'biz', {
      id: 'lib-1',
      mode: 'TEMPLATE',
    });
    expect(body.sourceType).toBe('LIBRARY_REFERENCE');
    expect(body.templateId).toBeUndefined();
  });

  it('auto-publish sends AUTO_ON_APPROVAL and one target per chosen account', () => {
    const body = buildCreateBody(
      {
        ...base,
        platforms: ['tiktok', 'x', 'facebook'],
        autoPublish: true,
        autoPublishAccounts: { tiktok: 'conn-1', facebook: 'conn-fb' },
      },
      'biz',
      null,
    );
    expect(body.publishPolicy).toBe('AUTO_ON_APPROVAL');
    // X has no account chosen, so it is left out; Facebook uses its Core-registered connection.
    expect(body.autoPublish).toEqual({
      targets: [
        { platform: 'tiktok', connectionId: 'conn-1' },
        { platform: 'facebook', connectionId: 'conn-fb' },
      ],
    });
  });

  it('auto-publish needs at least one account', () => {
    expect(validateCreate({ ...base, autoPublish: true }, 'biz')).toEqual([
      'autoPublishAccountRequired',
    ]);
  });
});

describe('QA: controls hidden or disabled for slideshows never block them', () => {
  const slideshow: CreateState = { ...base, source: 'SLIDESHOW', templateId: 't1' };

  it('ignores auto-publish left on from the video form (no account picker is shown)', () => {
    expect(validateCreate({ ...slideshow, autoPublish: true }, 'biz')).toEqual([]);
  });

  it('ignores a schedule left in the disabled schedule field', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 16);
    expect(validateCreate({ ...slideshow, scheduleAt: past }, 'biz')).toEqual([]);
  });
});

describe('QA: upload project name', () => {
  const upload: CreateState = {
    ...base,
    brief: '',
    source: 'UPLOAD',
    upload: { id: 'u1', fileName: 'my-clip.mp4' },
  };

  it('drops the extension only', () => {
    expect(buildCreateBody(upload, 'biz', null).name).toBe('my-clip');
  });

  it('keeps a file name that has no extension', () => {
    const state = { ...upload, upload: { id: 'u1', fileName: 'holiday' } };
    expect(buildCreateBody(state, 'biz', null).name).toBe('holiday');
  });
});

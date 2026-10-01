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

// 20.12 — "platforms" (formats to render) vs "accounts" (connected accounts to post to).
describe('20.12 auto-publish accounts', () => {
  const now = Date.parse('2026-10-01T10:00:00Z');
  const nine = [
    'tiktok',
    'instagram_reel',
    'youtube_short',
    'youtube',
    'linkedin_video',
    'x',
    'facebook',
    'instagram_feed',
    'facebook_feed',
  ];
  const screenshot: CreateState = {
    ...base,
    brief: 'AheadAi launch',
    source: 'SLIDESHOW',
    templateId: 'tpl_1',
    platforms: nine,
  };

  it('regression: a slideshow with 9 platforms and no connected account is not blocked', () => {
    // Auto-publish off (the Create screen forces it off with no account): nothing to choose.
    expect(validateCreate(screenshot, 'biz', now, [])).toEqual([]);
    const body = buildCreateBody(screenshot, 'biz', null);
    expect(body.sourceType).toBe('SLIDESHOW');
    expect(body.publishPolicy).toBeUndefined();
    expect(body.autoPublish).toBeUndefined();
  });

  it('no matching account: says so instead of "choose an account"', () => {
    const state = { ...base, platforms: ['linkedin_video'], autoPublish: true };
    expect(validateCreate(state, 'biz', now, ['tiktok'])).toEqual(['autoPublishNoMatchingAccount']);
    expect(validateCreate(state, 'biz', now, [])).toEqual(['autoPublishNoMatchingAccount']);
  });

  it('a matching account that is not picked: asks to pick it', () => {
    const state = { ...base, platforms: ['tiktok', 'x'], autoPublish: true };
    expect(validateCreate(state, 'biz', now, ['tiktok'])).toEqual(['autoPublishAccountRequired']);
    expect(
      validateCreate({ ...state, autoPublishAccounts: { tiktok: 'conn_tt' } }, 'biz', now, [
        'tiktok',
      ]),
    ).toEqual([]);
  });

  it('a schedule without an account explains that it needs one', () => {
    const later = { ...base, scheduleAt: '2026-10-05T10:00' };
    expect(validateCreate(later, 'biz', now, [])).toEqual(['scheduleNeedsAccount']);
    expect(validateCreate(later, 'biz', now, ['tiktok'])).toEqual(['scheduleNeedsAutoPublish']);
    expect(validateCreate({ ...base, scheduleNextSlot: true }, 'biz', now, [])).toEqual([
      'scheduleNeedsAccount',
    ]);
  });

  it('slideshows and uploads auto-publish and schedule like videos', () => {
    const slideshow = {
      ...screenshot,
      platforms: ['tiktok'],
      autoPublish: true,
      autoPublishAccounts: { tiktok: 'conn_tt' },
      scheduleAt: '2026-10-05T10:00',
    };
    expect(validateCreate(slideshow, 'biz', now, ['tiktok'])).toEqual([]);
    expect(buildCreateBody(slideshow, 'biz', null)).toMatchObject({
      sourceType: 'SLIDESHOW',
      publishPolicy: 'SCHEDULED',
      scheduledStartAt: new Date('2026-10-05T10:00').toISOString(),
      autoPublish: { targets: [{ platform: 'tiktok', connectionId: 'conn_tt' }] },
    });
    // Before 20.12 a slideshow with a schedule but no auto-publish slipped through.
    expect(validateCreate({ ...slideshow, autoPublish: false }, 'biz', now, ['tiktok'])).toEqual([
      'scheduleNeedsAutoPublish',
    ]);
    const upload = buildCreateBody(
      {
        ...base,
        source: 'UPLOAD',
        upload: { id: 'up_1', fileName: 'clip.mp4' },
        autoPublish: true,
        autoPublishAccounts: { tiktok: 'conn_tt' },
        scheduleNextSlot: true,
      },
      'biz',
      null,
    );
    expect(upload).toMatchObject({ sourceType: 'UPLOAD', publishPolicy: 'SCHEDULED' });
    expect(upload.autoPublish?.targets).toHaveLength(1);
  });
});

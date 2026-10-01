import { describe, expect, it, vi } from 'vitest';
import {
  AutoPublishAccountRequiredError,
  AutoPublishAccountUnavailableError,
  ForbiddenError,
  ValidationError,
} from '../../errors';
import {
  assertMayConfigureTargets,
  assertTargetsForPolicy,
  autoPublishTarget,
  readPublishDefaults,
  storedTargets,
  validateTargets,
} from './targets';

const tiktok = { platform: 'tiktok' as const, connectionId: 'conn-tt' };

describe('autoPublishTarget', () => {
  it('needs a connectionId for Studio platforms and a connection or account id for Meta', () => {
    expect(autoPublishTarget.safeParse(tiktok).success).toBe(true);
    expect(autoPublishTarget.safeParse({ platform: 'tiktok' }).success).toBe(false);
    expect(autoPublishTarget.safeParse({ platform: 'facebook' }).success).toBe(false);
    expect(
      autoPublishTarget.safeParse({ platform: 'instagram_reel', platformAccountId: 'ig-1' })
        .success,
    ).toBe(true);
    expect(
      autoPublishTarget.safeParse({ platform: 'facebook', connectionId: 'conn-fb' }).success,
    ).toBe(true);
  });

  it('bounds the schedule offset and rejects unknown keys', () => {
    expect(autoPublishTarget.safeParse({ ...tiktok, scheduleOffsetMinutes: 0 }).success).toBe(
      false,
    );
    expect(
      autoPublishTarget.safeParse({ ...tiktok, scheduleOffsetMinutes: 180 * 24 * 60 }).success,
    ).toBe(false);
    expect(autoPublishTarget.safeParse({ ...tiktok, scheduleOffsetMinutes: 60 }).success).toBe(
      true,
    );
    expect(autoPublishTarget.safeParse({ ...tiktok, accessToken: 'x' }).success).toBe(false);
  });
});

describe('storedTargets / readPublishDefaults', () => {
  it('reads targets from project metadata and ignores malformed data', () => {
    expect(storedTargets({ autoPublish: { targets: [tiktok] } })).toEqual([tiktok]);
    expect(storedTargets({ autoPublish: { targets: [{ platform: 'nope' }] } })).toEqual([]);
    expect(storedTargets(null)).toEqual([]);
    expect(storedTargets({})).toEqual([]);
  });

  it('parses publish defaults with an empty target list by default', () => {
    expect(readPublishDefaults({ publishPolicy: 'MANUAL' })).toEqual({
      publishPolicy: 'MANUAL',
      targets: [],
    });
    expect(readPublishDefaults({ publishPolicy: 'LATER' })).toBeNull();
    expect(readPublishDefaults(null)).toBeNull();
  });
});

describe('assertMayConfigureTargets', () => {
  it('needs studio:publication:write only when there are targets', () => {
    expect(() => assertMayConfigureTargets({ capabilities: [] }, [])).not.toThrow();
    expect(() => assertMayConfigureTargets({ capabilities: [] }, [tiktok])).toThrow(ForbiddenError);
    expect(() =>
      assertMayConfigureTargets({ capabilities: ['studio:publication:write'] }, [tiktok]),
    ).not.toThrow();
    expect(() => assertMayConfigureTargets({ capabilities: ['studio:*'] }, [tiktok])).not.toThrow();
  });
});

describe('validateTargets', () => {
  const db = (rows: Array<{ id: string; platform: string }>) => {
    const findMany = vi.fn(async () => rows);
    return { db: { platformConnection: { findMany } } as never, findMany };
  };

  it('accepts connections of the right platform in the organisation', async () => {
    const { db: fake, findMany } = db([{ id: 'conn-tt', platform: 'tiktok' }]);
    await expect(validateTargets(fake, 'org', [tiktok], ['tiktok'])).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['conn-tt'] }, organisationId: 'org' },
      select: { id: true, platform: true },
    });
  });

  it('reports format problems: platform not rendered, duplicates', async () => {
    const { db: fake } = db([{ id: 'conn-yt', platform: 'youtube' }]);
    const err = await validateTargets(
      fake,
      'org',
      [tiktok, tiktok, { platform: 'x', connectionId: 'conn-yt' }],
      ['tiktok'],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const problems = (err as ValidationError).details?.problems as string[];
    expect(problems.join('\n')).toMatch(/targets\[1\]: duplicate target/);
    expect(problems.join('\n')).toMatch(/targets\[2\]: x is not one of the project's formats/);
  });

  it('20.12: an account that is not this organisation’s has its own code', async () => {
    const { db: fake } = db([{ id: 'conn-yt', platform: 'youtube' }]);
    const err = await validateTargets(
      fake,
      'org',
      [tiktok, { platform: 'x', connectionId: 'conn-yt' }],
      ['tiktok', 'x'],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutoPublishAccountUnavailableError);
    expect((err as AutoPublishAccountUnavailableError).code).toBe(
      'auto_publish_account_unavailable',
    );
    const problems = (err as AutoPublishAccountUnavailableError).details?.problems as string[];
    expect(problems.join('\n')).toMatch(/targets\[0\]: connectionId is not a tiktok connection/);
    expect(problems.join('\n')).toMatch(/targets\[1\]: connectionId is not a x connection/);
  });

  it('20.12: auto-publish or a schedule needs at least one target', () => {
    expect(() => assertTargetsForPolicy('AUTO_ON_APPROVAL', [])).toThrow(
      AutoPublishAccountRequiredError,
    );
    expect(() => assertTargetsForPolicy('SCHEDULED', [])).toThrow(AutoPublishAccountRequiredError);
    expect(() => assertTargetsForPolicy('MANUAL', [])).not.toThrow();
    expect(() => assertTargetsForPolicy(undefined, [])).not.toThrow();
    expect(() => assertTargetsForPolicy('SCHEDULED', [tiktok])).not.toThrow();
  });

  it('skips the lookup when no target uses a Studio connection', async () => {
    const { db: fake, findMany } = db([]);
    await validateTargets(
      fake,
      'org',
      [{ platform: 'facebook', platformAccountId: 'fb-1' }],
      ['facebook'],
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});

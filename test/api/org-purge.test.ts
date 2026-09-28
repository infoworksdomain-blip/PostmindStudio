import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as purgeRoute from '../../src/app/api/studio/internal/organisations/[id]/purge/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.22 — POST /api/studio/internal/organisations/:id/purge (X-Service-Token), mirroring
// Engagement 14.13: tokens wiped and channels disconnected at once, the workspace kill switch
// engaged, scheduled posts cancelled, projects soft-deleted with a 30-day grace; idempotent;
// audited; other organisations untouched; no token in the response.

const hasDb = Boolean(process.env.DATABASE_URL);
const SERVICE_TOKEN = 't'.repeat(48);
const auth = { 'x-service-token': SERVICE_TOKEN };

describe.skipIf(!hasDb)('internal organisation purge API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-purge-${randomUUID()}`;
  const other = `api-purge-other-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;

  const channel = (organisationId: string, platform: string) =>
    db.platformConnection.create({
      data: {
        organisationId,
        platform,
        platformAccountId: `${platform}-${randomUUID()}`,
        platformAccountName: 'Leeds Sourdough',
        encryptedAccessToken: 'sealed-access-token',
        encryptedRefreshToken: 'sealed-refresh-token',
        scopes: ['publish'],
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });

  const project = (organisationId: string) =>
    db.videoProject.create({
      data: {
        organisationId,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Anything',
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });

  beforeEach(() => {
    vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
    api = installApi(db, { owner: tenant(org) });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: { in: [org, other] } } })
    ).map((p) => p.id);
    const pubs = (await db.videoPublication.findMany({ where: { projectId: { in: ids } } })).map(
      (p) => p.id,
    );
    await db.scheduledPublication.deleteMany({ where: { publicationId: { in: pubs } } });
    await db.videoPublication.deleteMany({ where: { id: { in: pubs } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.providerCredential.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.organisationPurge.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.systemFlag.deleteMany({
      where: { key: { in: [flagKeys.workspace(org), flagKeys.workspace(other)] } },
    });
    await db.$disconnect();
  });

  it('404s while the internal API is off and 401s a wrong token; JWTs are not accepted', async () => {
    vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', '');
    expect(
      (await call(purgeRoute.POST, { method: 'POST', params: { id: org }, headers: auth })).status,
    ).toBe(404);
    vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
    const wrong = await call(purgeRoute.POST, {
      method: 'POST',
      params: { id: org },
      headers: { 'x-service-token': 'nope' },
    });
    expect(wrong.status).toBe(401);
    const jwt = await call(purgeRoute.POST, {
      method: 'POST',
      params: { id: org },
      token: 'owner',
    });
    expect(jwt.status).toBe(401);
  });

  it('wipes tokens, stops work, cancels scheduled posts and soft-deletes with a 30-day grace', async () => {
    const [ig, tiktok, keep] = [
      await channel(org, 'instagram'),
      await channel(org, 'tiktok'),
      await channel(other, 'instagram'),
    ];
    const [mine, theirs] = [await project(org), await project(other)];
    const byoc = (organisationId: string) =>
      db.providerCredential.create({
        data: {
          organisationId,
          providerId: 'runway',
          encryptedKey: 'sealed-byoc-key',
          encryptedSecondaryKey: 'sealed-byoc-secondary',
          createdByUserId: 'user-1',
        },
      });
    const [myKey, theirKey] = [await byoc(org), await byoc(other)];
    const render = await db.videoRender.create({
      data: {
        projectId: mine.id,
        scriptId: 'script-x',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `r/${randomUUID()}.mp4`,
        qualityCheckState: 'PASSED',
      },
    });
    const scheduled = await db.videoPublication.create({
      data: {
        organisationId: org,
        projectId: mine.id,
        renderId: render.id,
        platform: 'tiktok',
        platformAccountId: tiktok.platformAccountId,
        state: 'SCHEDULED',
        scheduledFor: new Date(Date.now() + 86_400_000),
      },
    });
    await db.scheduledPublication.create({
      data: {
        publicationId: scheduled.id,
        scheduledFor: new Date(Date.now() + 86_400_000),
        state: 'PENDING',
      },
    });

    const res = await call(purgeRoute.POST, { method: 'POST', params: { id: org }, headers: auth });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({
      ok: true,
      purge: {
        organisationId: org,
        channelsWiped: 2,
        projectsDeleted: 1,
        publicationsCancelled: 1,
        repeated: false,
      },
    });
    expect(JSON.stringify(res.json)).not.toContain('sealed-access-token');
    const purge = res.json.purge as { requestedAt: string; graceUntil: string };
    expect(Date.parse(purge.graceUntil) - Date.parse(purge.requestedAt)).toBe(30 * 86_400_000);

    for (const id of [ig.id, tiktok.id]) {
      const row = await db.platformConnection.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        state: 'revoked',
        encryptedAccessToken: '',
        encryptedRefreshToken: null,
      });
    }
    expect((await db.platformConnection.findUniqueOrThrow({ where: { id: keep.id } })).state).toBe(
      'active',
    );
    // BYOC provider keys are wiped at once too; another organisation's stay.
    expect(
      await db.providerCredential.findUniqueOrThrow({ where: { id: myKey.id } }),
    ).toMatchObject({ state: 'revoked', encryptedKey: null, encryptedSecondaryKey: null });
    expect(
      await db.providerCredential.findUniqueOrThrow({ where: { id: theirKey.id } }),
    ).toMatchObject({ state: 'active', encryptedKey: 'sealed-byoc-key' });
    expect(
      (await db.videoProject.findUniqueOrThrow({ where: { id: mine.id } })).deletedAt,
    ).not.toBeNull();
    expect(
      (await db.videoProject.findUniqueOrThrow({ where: { id: theirs.id } })).deletedAt,
    ).toBeNull();
    expect(
      (await db.videoPublication.findUniqueOrThrow({ where: { id: scheduled.id } })).state,
    ).toBe('CANCELLED');
    expect(
      (await db.systemFlag.findUnique({ where: { key: flagKeys.workspace(org) } }))?.value,
    ).toBe('true');
    expect(api.audits.find((a) => a.action === 'studio.organisation.purge')).toMatchObject({
      actorUserId: 'system:postmind-core',
      organisationId: org,
      metadata: expect.objectContaining({ channelsWiped: 2, graceUntil: purge.graceUntil }),
    });

    // Idempotent: a repeat keeps the first grace period and finds nothing new.
    const again = await call(purgeRoute.POST, {
      method: 'POST',
      params: { id: org },
      headers: auth,
    });
    expect(again.status).toBe(202);
    expect(again.json).toMatchObject({
      purge: { channelsWiped: 0, projectsDeleted: 0, repeated: true, graceUntil: purge.graceUntil },
    });
  });
});

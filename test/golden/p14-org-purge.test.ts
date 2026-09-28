import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as purgePlanRoute from '../../src/app/api/studio/admin/organisations/[id]/purge-plan/route';
import * as purgeRoute from '../../src/app/api/studio/internal/organisations/[id]/purge/route';
import type { AuditEntry } from '../../src/lib/audit';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { hardDeletePurgedOrgs } from '../../src/lib/studio/queue/workers/data-retention';
import {
  hardDeleteOrganisation,
  type PurgePlan,
} from '../../src/lib/studio/services/organisation-hard-delete';
import { countRows, PURGE_TABLE_STEPS } from '../../src/lib/studio/services/purge-tables';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, tenant } from '../helpers/api-harness';
import {
  approvedTikTokProject,
  cleanupGolden,
  connect,
  drain,
  ORG_PREFIX,
  publish,
  startJourney,
  type Journey,
} from './journey-kit';

// BACKLOG 14.1 golden journey — organisation purge end to end, on real routes, real workers and
// real Postgres with in-memory S3:
//   P14-01  Two organisations make, approve and publish videos. Core purges one (internal
//           route) → staff dry run lists its rows and objects, not due → the grace passes → the
//           daily hard-delete job deletes every row in every studio table and every object under
//           orgs/<id>/ → nothing is left for that org, the tombstone records what went, the
//           audit entry is written, the other organisation (including an id that shares the
//           prefix characters) is untouched, and a second run changes nothing.

const hasDb = Boolean(process.env.DATABASE_URL);
const SERVICE_TOKEN = 's'.repeat(48);
const STAFF_ORG = `${ORG_PREFIX}-staff`;
const DAY_MS = 86_400_000;
const HOOK_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDb)(
  'golden journey: organisation purge → hard delete',
  { timeout: 180_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();
    const purgedOrgs: string[] = [];

    afterEach(() => vi.unstubAllEnvs());

    afterAll(async () => {
      setApiDeps(undefined);
      await cleanupGolden(db, since);
      await db.organisationPurge.deleteMany({ where: { organisationId: { in: purgedOrgs } } });
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    function journey(id: string): Journey {
      vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF_ORG);
      vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
      vi.stubEnv('S3_BUCKET_ASSETS', 'assets');
      vi.stubEnv('S3_BUCKET_RENDERS', 'renders');
      vi.stubEnv('S3_BUCKET_THUMBNAILS', '');
      vi.stubEnv('S3_BUCKET_LIBRARY', '');
      vi.stubEnv('STUDIO_PURGE_GRACE_DAYS', '');
      return startJourney(
        db,
        id,
        {},
        {
          staff: tenant(STAFF_ORG, ['studio:admin:moderation'], 'staff-1'),
        },
      );
    }

    /** A busy organisation: a published video plus rows in the business/upload/policy tables. */
    async function populate(j: Journey) {
      await connect(j, 'tiktok');
      const { render } = await approvedTikTokProject(j);
      const connection = await db.platformConnection.findFirstOrThrow({
        where: { organisationId: j.org, platform: 'tiktok' },
      });
      await publish(j, {
        renderId: render.id,
        platform: 'tiktok',
        connectionId: connection.id,
        caption: 'Fresh sourdough',
      });
      await drain(j);
      await db.brandKit.create({
        data: {
          organisationId: j.org,
          businessId: 'biz-golden',
          name: 'Kit',
          colourPalette: ['#000000'],
          toneKeywords: [],
          ctaTemplates: [],
          restrictedTopics: [],
        },
      });
      await db.orgPolicy.create({ data: { organisationId: j.org, updatedByUserId: 'staff-1' } });
      await db.notificationPreference.create({
        data: { organisationId: j.org, userId: 'user-1', kind: 'cost_alert' },
      });
      const upload = await db.videoUpload.create({
        data: {
          organisationId: j.org,
          createdByUserId: 'user-1',
          kind: 'SOURCE_VIDEO',
          fileName: 'clip.mp4',
          contentType: 'video/mp4',
          declaredBytes: BigInt(3),
          s3Bucket: 'assets',
          s3Key: `orgs/${j.org}/uploads/u1/source.mp4`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await j.h.deps.storage.put({
        bucket: upload.s3Bucket,
        key: upload.s3Key,
        body: new Uint8Array([1, 2, 3]),
        contentType: 'video/mp4',
      });
    }

    async function rowCounts(org: string) {
      const counts: Record<string, number> = {};
      for (const step of PURGE_TABLE_STEPS) counts[step.table] = await countRows(db, step, org);
      return counts;
    }

    const objectsUnder = (j: Journey, prefix: string) =>
      [...j.h.objects.keys()].filter((k) => k.split('/').slice(1).join('/').startsWith(prefix));

    it('P14-01 purge → grace → hard delete leaves nothing for the org and the other org intact', async () => {
      // journey() installs the API for its org, so each org is populated right after its install.
      // keep's id starts with gone's id: orgs/<gone>-keep/ must survive gone's purge.
      const keep = journey('purge-keep');
      await populate(keep);
      const gone = journey('purge');
      await populate(gone);
      purgedOrgs.push(gone.org, keep.org);
      // Keep's objects also live in gone's bucket store, so prefix isolation is tested for real.
      await gone.h.deps.storage.put({
        bucket: 'renders',
        key: `orgs/${keep.org}/projects/p/providers/x/keep.mp4`,
        body: new Uint8Array([9]),
        contentType: 'video/mp4',
      });
      const keepBefore = await rowCounts(keep.org);
      const goneBefore = await rowCounts(gone.org);
      expect(goneBefore.video_projects).toBe(1);
      expect(goneBefore.video_publications).toBe(1);
      expect(goneBefore.video_assets).toBeGreaterThan(0);
      expect(objectsUnder(gone, `orgs/${gone.org}/`).length).toBeGreaterThan(0);

      // Core purges the organisation: soft delete with the 30-day grace.
      const purged = await call(purgeRoute.POST, {
        method: 'POST',
        params: { id: gone.org },
        headers: { 'x-service-token': SERVICE_TOKEN },
      });
      expect(purged.status).toBe(202);

      // Staff dry run: counts per table and prefix, not due yet, nothing deleted.
      const planRes = await call(purgePlanRoute.GET, { token: 'staff', params: { id: gone.org } });
      expect(planRes.status).toBe(200);
      const plan = planRes.json.plan as PurgePlan;
      expect(plan.purge).toMatchObject({ state: 'soft_deleted', due: false });
      expect(plan.tables.find((t) => t.table === 'video_projects')?.rows).toBe(1);
      expect(plan.storage.map((s) => s.bucket)).toEqual(['assets', 'renders']);
      expect(plan.totals.objects).toBe(objectsUnder(gone, `orgs/${gone.org}/`).length);
      expect(plan.totals.rows).toBe(Object.values(goneBefore).reduce((a, b) => a + b, 0));
      expect(await rowCounts(gone.org)).toEqual(goneBefore);
      expect(
        (await call(purgePlanRoute.GET, { token: 'owner', params: { id: gone.org } })).status,
      ).toBe(403);

      // The daily job before the grace ends does nothing.
      const audits: AuditEntry[] = [];
      const jobDeps = (atMs: number) => ({
        ...gone.h.deps,
        now: () => atMs,
        audit: (e: AuditEntry) => audits.push(e),
        logger: pino({ level: 'silent' }),
      });
      const data = {
        organisationId: 'postmind-platform',
        runId: 'hard-delete',
        planTier: 'STANDARD' as const,
      };
      await hardDeletePurgedOrgs(data, jobDeps(Date.now() + 29 * DAY_MS));
      expect(await rowCounts(gone.org)).toEqual(goneBefore);

      // 31 days later: hard delete.
      const later = Date.now() + 31 * DAY_MS;
      await hardDeletePurgedOrgs(data, jobDeps(later));
      const after = await rowCounts(gone.org);
      expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
      expect(objectsUnder(gone, `orgs/${gone.org}/`)).toEqual([]);

      // Tombstone + audit; the workspace kill switch stays engaged.
      const tomb = await db.organisationPurge.findUniqueOrThrow({
        where: { organisationId: gone.org },
      });
      expect(tomb.state).toBe('hard_deleted');
      expect(tomb.hardDeletedAt?.getTime()).toBe(later);
      const summary = tomb.hardDeleteSummary as {
        tables: Record<string, number>;
        storage: Record<string, { objects: number }>;
      };
      expect(summary.tables.video_projects).toBe(1);
      expect(summary.tables.video_publications).toBe(1);
      expect(Object.values(summary.storage).reduce((n, s) => n + s.objects, 0)).toBe(
        plan.totals.objects,
      );
      expect(audits).toEqual([
        expect.objectContaining({
          action: 'studio.organisation.hard_delete',
          organisationId: gone.org,
          actorUserId: 'system:organisation-purge',
        }),
      ]);
      expect(
        (await db.systemFlag.findUnique({ where: { key: flagKeys.workspace(gone.org) } }))?.value,
      ).toBe('true');

      // The other organisation is untouched: rows and objects (same bucket, similar prefix).
      expect(await rowCounts(keep.org)).toEqual(keepBefore);
      expect(objectsUnder(gone, `orgs/${keep.org}/`)).toHaveLength(1);
      expect(objectsUnder(keep, `orgs/${keep.org}/`).length).toBeGreaterThan(0);

      // Idempotent: another run finds nothing to do.
      await hardDeletePurgedOrgs(data, jobDeps(later + DAY_MS));
      expect(audits).toHaveLength(1);
      const planAfter = await call(purgePlanRoute.GET, {
        token: 'staff',
        params: { id: gone.org },
      });
      expect((planAfter.json.plan as PurgePlan).totals).toEqual({ rows: 0, objects: 0, bytes: 0 });
      expect((planAfter.json.plan as PurgePlan).purge).toMatchObject({
        state: 'hard_deleted',
        due: false,
      });

      // Cleanup of the kept organisation uses the same machinery (and proves resumability from
      // soft_deleted state set directly).
      await db.organisationPurge.create({
        data: {
          organisationId: keep.org,
          graceUntil: new Date(0),
          channelsWiped: 0,
          projectsDeleted: 0,
          publicationsCancelled: 0,
          state: 'soft_deleted',
        },
      });
      await hardDeleteOrganisation(
        { ...jobDeps(later), buckets: ['assets', 'renders'], storage: keep.h.deps.storage },
        keep.org,
      );
      await db.systemFlag.deleteMany({
        where: { key: { in: [flagKeys.workspace(gone.org), flagKeys.workspace(keep.org)] } },
      });
    });
  },
);

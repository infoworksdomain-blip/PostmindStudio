import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../../errors';
import { studioModes } from '../../mode';
import type { PipelineDeps } from '../pipeline/deps';
import { reconcileOrganisationsJob, reportUsage, syncCalendar } from '../queue/workers/core-sync';
import { pendingCoreBusinessDirectory } from './business-directory';
import { pendingCoreOrganisationDirectory } from './organisation-directory';
import {
  assertLocalBusinesses,
  businessesAreLocal,
  coreContentAvailable,
  engagementEnabled,
  selectBusinessDirectory,
  selectBusinessGuard,
  selectCoreSyncClients,
  selectMetaConnect,
} from './select';

// Phase 18 §2.12 — the adapters chosen per mode, and the standalone promise: nothing calls a
// POSTMIND_* (or ENGAGEMENT_*) URL. fetch is spied for the whole file and must stay untouched.

const standalone = studioModes({});
const core = studioModes({ STUDIO_MODE: 'core' });
const logger = pino({ level: 'silent' });
const RUN = { runId: 'run-1' } as never;

const fetchSpy = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`unexpected network call to ${String(input)}`);
});

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  // A standalone deployment may still carry stale Core values: they must not be used.
  vi.stubEnv('POSTMIND_CORE_URL', 'https://core.invalid');
  vi.stubEnv('POSTMIND_AUDIT_URL', 'https://core.invalid/audit');
  vi.stubEnv('POSTMIND_SERVICE_TOKEN', 'token');
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fakeDb() {
  const businesses = [
    { id: 'b1', name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk', organisationId: 'org-1' },
    { id: 'b2', name: 'Market stall', domain: null, organisationId: 'org-1' },
  ];
  return {
    business: {
      findMany: vi.fn(async ({ where }: { where: { organisationId: string } }) =>
        businesses
          .filter((b) => b.organisationId === where.organisationId)
          .map((b) => ({ ...b, createdAt: new Date(0), updatedAt: new Date(0) })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; organisationId: string } }) =>
        businesses.find((b) => b.id === where.id && b.organisationId === where.organisationId)
          ? { id: where.id }
          : null,
      ),
    },
    organization: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => id !== 'org-gone').map((id) => ({ id })),
      ),
    },
    usageEvent: { createMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 0) },
    videoRender: { findMany: vi.fn(async () => []) },
    providerJob: { findMany: vi.fn(async () => []) },
    calendarShadow: { findMany: vi.fn(), count: vi.fn() },
    brandKit: { findMany: vi.fn(async () => [{ organisationId: 'org-1' }]) },
    platformConnection: { findMany: vi.fn(async () => [{ organisationId: 'org-gone' }]) },
    videoProject: { findMany: vi.fn(async () => []) },
    organisationPurge: { findMany: vi.fn(async () => []) },
  };
}

function pipelineDeps(db: ReturnType<typeof fakeDb>, modes = standalone): PipelineDeps {
  return {
    db,
    core: selectCoreSyncClients(modes, db as never),
    logger,
    audit: vi.fn(),
    now: () => Date.UTC(2026, 9, 1),
  } as unknown as PipelineDeps;
}

describe('standalone mode makes no PostMind Core or Engagement call', () => {
  it('lists businesses from studio.businesses', async () => {
    const db = fakeDb();
    const directory = selectBusinessDirectory(standalone, db as never);
    expect(await directory.listBusinesses('org-1')).toEqual([
      { id: 'b1', name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk' },
      { id: 'b2', name: 'Market stall' },
    ]);
    expect(db.business.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: 'org-1', deletedAt: null } }),
    );
  });

  it('guards business ids locally: another organisation’s business is a 404', async () => {
    const guard = selectBusinessGuard(standalone, fakeDb() as never);
    await expect(guard?.('org-1', 'b1')).resolves.toBeUndefined();
    await expect(guard?.('org-2', 'b1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('records usage locally (state local) and never flushes to Core', async () => {
    const db = fakeDb();
    db.videoRender.findMany.mockResolvedValueOnce([
      {
        id: 'r1',
        projectId: 'p1',
        targetPlatform: 'tiktok',
        durationSec: 30,
        resolution: '1080x1920',
        createdAt: new Date(0),
        costPence: 10,
        project: { organisationId: 'org-1', costCurrency: 'GBP' },
      },
    ] as never);
    await reportUsage(RUN, pipelineDeps(db));
    expect(db.usageEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ eventKey: 'render:r1', state: 'local' })],
      skipDuplicates: true,
    });
    expect(db.usageEvent.count).not.toHaveBeenCalled();
  });

  it('skips Core channel reconciliation (Studio owns the Meta login)', async () => {
    const { reconcileChannels } = await import('../queue/workers/reconcile-channels');
    const db = { ...fakeDb(), platformConnection: { findMany: vi.fn() } };
    await reconcileChannels(RUN, pipelineDeps(db as never));
    expect(db.platformConnection.findMany).not.toHaveBeenCalled();
    expect(selectCoreSyncClients(standalone, db as never).channelReconciliation).toBe(false);
  });

  it('keeps no calendar shadows', async () => {
    const db = fakeDb();
    await syncCalendar(RUN, pipelineDeps(db));
    expect(db.calendarShadow.findMany).not.toHaveBeenCalled();
    expect(db.calendarShadow.count).not.toHaveBeenCalled();
  });

  it('answers organisation existence from studio.organisations (the purge is a DB test)', async () => {
    const db = fakeDb();
    const directory = pipelineDeps(db).core!.organisations!;
    expect(directory.ready).toBe(true);
    expect([...(await directory.existing(['org-1', 'org-gone']))]).toEqual(['org-1']);
    expect(db.organization.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['org-1', 'org-gone'] }, deletedAt: null },
      select: { id: true },
    });
  });

  it('turns Engagement and Core content off', () => {
    vi.stubEnv('ENGAGEMENT_INTERNAL_URL', '');
    expect(engagementEnabled()).toBe(false);
    expect(coreContentAvailable(standalone)).toBe(false);
  });

  it('lets businesses be managed locally', () => {
    expect(businessesAreLocal(standalone)).toBe(true);
    expect(() => assertLocalBusinesses(standalone)).not.toThrow();
  });
});

describe('core mode keeps the pre-Phase-18 adapters', () => {
  it('uses Core’s pending business directory and no guard', () => {
    expect(selectBusinessDirectory(core, fakeDb() as never)).toBe(pendingCoreBusinessDirectory);
    expect(selectBusinessGuard(core, fakeDb() as never)).toBeUndefined();
    expect(() => assertLocalBusinesses(core)).toThrow(ConflictError);
  });

  it('keeps the usage outbox and calendar shadows, and has no local organisation directory', () => {
    const clients = selectCoreSyncClients(core, fakeDb() as never);
    expect(clients).toEqual({
      usageRecording: 'outbox',
      calendarShadows: true,
      channelReconciliation: true,
    });
  });

  it('skips organisation reconciliation until Core ships its endpoint', async () => {
    const db = fakeDb();
    await reconcileOrganisationsJob(RUN, pipelineDeps(db, core));
    expect(db.brandKit.findMany).not.toHaveBeenCalled();
    expect(pendingCoreOrganisationDirectory.ready).toBe(false);
  });

  it('offers Core content and Engagement only when configured', () => {
    expect(coreContentAvailable(core)).toBe(true);
    expect(engagementEnabled({ ENGAGEMENT_INTERNAL_URL: 'https://e.test' })).toBe(false);
    expect(
      engagementEnabled({ ENGAGEMENT_INTERNAL_URL: 'https://e.test', POSTMIND_SERVICE_TOKEN: 't' }),
    ).toBe(true);
  });

  it('prefers an injected Core directory over the mode default', () => {
    const injected = { listBusinesses: vi.fn() };
    expect(selectBusinessDirectory(standalone, fakeDb() as never, injected)).toBe(injected);
  });
});

describe('selectMetaConnect', () => {
  const env = {
    META_APP_ID: '1',
    META_APP_SECRET: 's',
    META_LOGIN_CONFIG_ID: '2',
    APP_URL: 'https://studio.test',
  };

  it('is configured only in studio mode with the operator’s app settings', () => {
    expect(selectMetaConnect(standalone, env).configured).toBe(true);
    expect(selectMetaConnect(standalone, {}).configured).toBe(false);
    expect(selectMetaConnect(core, env).configured).toBe(false);
    expect(selectMetaConnect(standalone, env).client().graphVersion).toBe('v26.0');
  });
});

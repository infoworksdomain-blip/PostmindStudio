import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as confirmRoute from '../../src/app/api/studio/admin/kill-switch/global/confirm/route';
import * as pendingRoute from '../../src/app/api/studio/admin/kill-switch/global/pending/route';
import * as killSwitchRoute from '../../src/app/api/studio/admin/kill-switch/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { getKillSwitch } from '../../src/lib/studio/kill-switch';
import {
  GLOBAL_KILL_CONFIRM_WINDOW_MS,
  PENDING_GLOBAL_KILL_KEY,
} from '../../src/lib/studio/services/kill-switch-admin';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, installApi, tenant } from '../helpers/api-harness';

// Covers src/lib/studio/services/kill-switch-admin.ts + the admin route: GET/PUT the four
// kill-switch levels, the STUDIO_PLATFORM_ORG_IDS staff guard, cache invalidation and audit
// (spec 12 / Admin Centre 16.4).

const hasDb = Boolean(process.env.DATABASE_URL);

const ADMIN_CAPS = ['studio:admin:kill-switch:read', 'studio:admin:kill-switch:write'];

describe.skipIf(!hasDb)('kill switch admin API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-ks-staff-${randomUUID()}`;
  const otherOrg = `api-ks-other-${randomUUID()}`;
  const providerId = 'runway';
  // A platform no other suite publishes to: the flag is platform-wide while engaged.
  const platform = 'facebook';
  const tokens = {
    staff: tenant(staffOrg, ADMIN_CAPS),
    // 15.D6: a second PostMind staff member (a different user in the staff organisation).
    staff2: tenant(staffOrg, ADMIN_CAPS, 'user-2'),
    staffNoCaps: tenant(staffOrg, []),
    outsider: tenant(otherOrg, ADMIN_CAPS),
  };

  const testKeys = () => [
    flagKeys.global(),
    flagKeys.provider(providerId),
    flagKeys.platform(platform),
    PENDING_GLOBAL_KILL_KEY,
  ];

  beforeEach(async () => {
    installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    await db.systemFlag.deleteMany({ where: { key: { in: testKeys() } } });
    (await getKillSwitch()).invalidate();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.systemFlag.deleteMany({ where: { key: { in: testKeys() } } });
    await db.$disconnect();
  });

  const get = (token = 'staff') => call(killSwitchRoute.GET, { token });
  const put = (body: unknown, token = 'staff') =>
    call(killSwitchRoute.PUT, { method: 'PUT', token, body });
  const confirm = (body: unknown, token = 'staff2') =>
    call(confirmRoute.POST, { method: 'POST', token, body });

  /** 15.D6: request the global kill as user-1, confirm it as user-2. */
  async function engageGlobal(reason: string) {
    const requested = await put({ level: 'global', enabled: true, reason });
    expect(requested.status).toBe(202);
    const { requestId } = requested.json.pending as { requestId: string };
    return confirm({ requestId, reason: `${reason} (confirmed)` });
  }

  it('reads the default state: global off, nothing frozen/killed/disabled', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json.global).toMatchObject({ enabled: false });
    expect(res.json.disabledProviders).toEqual([]);
    expect(res.json.disabledPlatforms).toEqual([]);
    expect(res.json.propagationSec).toBe(30);
  });

  it('engages and releases the global switch, invalidating the cache immediately', async () => {
    const killSwitch = await getKillSwitch();
    expect((await killSwitch.check({ organisationId: 'anyone' })).killed).toBe(false);

    const engaged = await engageGlobal('incident response');
    expect(engaged.status).toBe(200);
    const flag = engaged.json.flag as { key: string; value: string };
    expect(flag.key).toBe(flagKeys.global());
    expect(flag.value).toBe('true');

    // No 30s wait: PUT invalidates the process-wide cache, so this reflects the new value now.
    expect((await killSwitch.check({ organisationId: 'anyone' })).killed).toBe(true);

    const state = await get();
    expect((state.json.global as { enabled: boolean }).enabled).toBe(true);

    const released = await put({ level: 'global', enabled: false, reason: 'incident resolved' });
    expect(released.status).toBe(200);
    expect((await killSwitch.check({ organisationId: 'anyone' })).killed).toBe(false);
  });

  it('disables and re-enables a provider by id', async () => {
    const disabled = await put({
      level: 'provider',
      target: providerId,
      enabled: true,
      reason: 'provider outage',
    });
    expect(disabled.status).toBe(200);
    const state = await get();
    const providers = state.json.disabledProviders as Array<{ id: string }>;
    expect(providers.map((p) => p.id)).toContain(providerId);

    await put({ level: 'provider', target: providerId, enabled: false, reason: 'restored' });
    const after = await get();
    expect((after.json.disabledProviders as Array<{ id: string }>).map((p) => p.id)).not.toContain(
      providerId,
    );
  });

  it('halts and releases publishing to one platform, listed as disabledPlatforms', async () => {
    const halted = await put({
      level: 'platform',
      target: platform,
      enabled: true,
      reason: 'Meta app review strike',
    });
    expect(halted.status).toBe(200);
    expect((halted.json.flag as { key: string }).key).toBe(flagKeys.platform(platform));
    const killSwitch = await getKillSwitch();
    const scope = { organisationId: 'anyone', projectId: 'p', platform };
    expect(await killSwitch.check(scope)).toMatchObject({ killed: true, level: 'platform' });
    expect((await killSwitch.check({ ...scope, platform: 'youtube' })).killed).toBe(false);
    const state = await get();
    expect((state.json.disabledPlatforms as Array<{ id: string }>).map((p) => p.id)).toEqual([
      platform,
    ]);

    await put({ level: 'platform', target: platform, enabled: false, reason: 'appeal won' });
    expect((await killSwitch.check(scope)).killed).toBe(false);
    expect((await get()).json.disabledPlatforms).toEqual([]);
  });

  it('freezes a workspace and kills a project by target id', async () => {
    const workspaceTarget = `workspace-${randomUUID()}`;
    const projectTarget = `project-${randomUUID()}`;
    await put({
      level: 'workspace',
      target: workspaceTarget,
      enabled: true,
      reason: 'billing dispute',
    });
    await put({ level: 'project', target: projectTarget, enabled: true, reason: 'DMCA' });
    const state = await get();
    expect((state.json.frozenWorkspaces as Array<{ id: string }>).map((w) => w.id)).toContain(
      workspaceTarget,
    );
    expect((state.json.killedProjects as Array<{ id: string }>).map((p) => p.id)).toContain(
      projectTarget,
    );

    await db.systemFlag.deleteMany({
      where: {
        key: { in: [flagKeys.workspace(workspaceTarget), flagKeys.project(projectTarget)] },
      },
    });
  });

  it('records an audit entry on engage and release', async () => {
    const api = installApi(db, tokens);
    await engageGlobal('audit check');
    expect(api.audits.map((a) => a.action)).toEqual([
      'studio.kill_switch.global_requested',
      'studio.kill_switch.engage',
    ]);
    expect(api.audits[1]?.metadata).toMatchObject({
      level: 'global',
      twoPerson: true,
      requestedBy: 'user-1',
      confirmedBy: 'user-2',
    });
    await call(killSwitchRoute.PUT, {
      method: 'PUT',
      token: 'staff',
      body: { level: 'global', enabled: false, reason: 'audit check done' },
    });
    expect(api.audits.map((a) => a.action)).toContain('studio.kill_switch.release');
  });

  it('validates input: target required for non-global levels, unknown providerId, short reason', async () => {
    expect((await put({ level: 'workspace', enabled: true, reason: 'no target' })).status).toBe(
      400,
    );
    expect(
      (
        await put({
          level: 'provider',
          target: 'not-a-real-provider',
          enabled: true,
          reason: 'bad id',
        })
      ).status,
    ).toBe(400);
    expect(
      (await put({ level: 'platform', target: 'myspace', enabled: true, reason: 'bad id' })).status,
    ).toBe(400);
    expect((await put({ level: 'platform', enabled: true, reason: 'no target' })).status).toBe(400);
    expect((await put({ level: 'global', enabled: true, reason: 'x' })).status).toBe(400);
    expect((await put({ level: 'global', enabled: true })).status).toBe(400);
  });

  it('rejects staff without the admin capability, and non-staff organisations even with it', async () => {
    expect((await get('staffNoCaps')).status).toBe(403);
    expect((await put({ level: 'global', enabled: true, reason: 'x' }, 'staffNoCaps')).status).toBe(
      403,
    );
    expect((await get('outsider')).status).toBe(403);
    expect((await put({ level: 'global', enabled: true, reason: 'x' }, 'outsider')).status).toBe(
      403,
    );
  });

  describe('two-person global kill (15.D6 / spec 19.2)', () => {
    it('PUT only creates a pending request; the flag stays off until someone else confirms', async () => {
      const killSwitch = await getKillSwitch();
      const res = await put({ level: 'global', enabled: true, reason: 'cost runaway' });
      expect(res.status).toBe(202);
      expect(res.json.pending).toMatchObject({ requestedBy: 'user-1', reason: 'cost runaway' });
      expect((await killSwitch.check({ organisationId: 'anyone' })).killed).toBe(false);
      expect(await db.systemFlag.findUnique({ where: { key: flagKeys.global() } })).toBeNull();

      expect((await get('staff2')).json.pendingGlobal).toMatchObject({
        requestedBy: 'user-1',
        requestedByYou: false,
      });
      expect((await get()).json.pendingGlobal).toMatchObject({ requestedByYou: true });
      // A second request while one is live is refused.
      const again = await put({ level: 'global', enabled: true, reason: 'again' }, 'staff2');
      expect(again.status).toBe(409);
    });

    it('refuses the requester confirming their own request (403)', async () => {
      const res = await put({ level: 'global', enabled: true, reason: 'cost runaway' });
      const { requestId } = res.json.pending as { requestId: string };
      expect((await confirm({ requestId, reason: 'me again' }, 'staff')).status).toBe(403);
      expect((await get()).json.global).toMatchObject({ enabled: false });
    });

    it('refuses an expired request (409) and a wrong request id (409)', async () => {
      const api = installApi(db, tokens);
      const res = await put({ level: 'global', enabled: true, reason: 'cost runaway' });
      const { requestId } = res.json.pending as { requestId: string };
      expect((await confirm({ requestId: 'not-it', reason: 'agreed' })).status).toBe(409);
      const start = Date.now();
      api.deps.now = () => start + GLOBAL_KILL_CONFIRM_WINDOW_MS + 1_000;
      const late = await confirm({ requestId, reason: 'agreed' });
      expect(late.status).toBe(409);
      expect(late.json.details).toMatchObject({ reason: 'expired' });
      expect((await get()).json.global).toMatchObject({ enabled: false });
      // The expired request is cleared.
      expect((await confirm({ requestId, reason: 'agreed' })).status).toBe(404);
    });

    it('withdraws a pending request (audited) and 404s when none is pending', async () => {
      const api = installApi(db, tokens);
      await put({ level: 'global', enabled: true, reason: 'cost runaway' });
      const res = await call(pendingRoute.DELETE, { method: 'DELETE', token: 'staff2' });
      expect(res.status).toBe(200);
      expect(api.audits.map((a) => a.action)).toContain(
        'studio.kill_switch.global_request_withdrawn',
      );
      expect((await get()).json.pendingGlobal).toBeNull();
      const none = await call(pendingRoute.DELETE, { method: 'DELETE', token: 'staff2' });
      expect(none.status).toBe(404);
    });

    it('break-glass STUDIO_KILL_SWITCH_SINGLE_APPROVER=true engages at once, audited', async () => {
      const api = installApi(db, tokens);
      vi.stubEnv('STUDIO_KILL_SWITCH_SINGLE_APPROVER', 'true');
      const res = await put({ level: 'global', enabled: true, reason: 'INC-9 break glass' });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ breakGlass: true, flag: { value: 'true' } });
      expect((await get()).json).toMatchObject({ singleApprover: true, global: { enabled: true } });
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.kill_switch.engage',
        metadata: { breakGlass: true, level: 'global' },
      });
      // Releasing is always one person.
      expect((await put({ level: 'global', enabled: false, reason: 'resolved' })).status).toBe(200);
    });

    it('validates the confirm body and refuses non-staff', async () => {
      expect((await confirm({ reason: 'no id' })).status).toBe(400);
      expect((await confirm({ requestId: 'x', reason: 'ok', extra: 1 })).status).toBe(400);
      expect((await confirm({ requestId: 'x', reason: 'ok' }, 'outsider')).status).toBe(403);
      expect((await confirm({ requestId: 'x', reason: 'ok' }, 'staffNoCaps')).status).toBe(403);
      expect((await call(confirmRoute.POST, { method: 'POST', body: {} })).status).toBe(401);
    });
  });
});

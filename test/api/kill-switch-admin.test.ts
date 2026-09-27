import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as killSwitchRoute from '../../src/app/api/studio/admin/kill-switch/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { getKillSwitch } from '../../src/lib/studio/kill-switch';
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
  const tokens = {
    staff: tenant(staffOrg, ADMIN_CAPS),
    staffNoCaps: tenant(staffOrg, []),
    outsider: tenant(otherOrg, ADMIN_CAPS),
  };

  beforeEach(async () => {
    installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    await db.systemFlag.deleteMany({
      where: { key: { in: [flagKeys.global(), flagKeys.provider(providerId)] } },
    });
    (await getKillSwitch()).invalidate();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.systemFlag.deleteMany({
      where: { key: { in: [flagKeys.global(), flagKeys.provider(providerId)] } },
    });
    await db.$disconnect();
  });

  const get = (token = 'staff') => call(killSwitchRoute.GET, { token });
  const put = (body: unknown, token = 'staff') =>
    call(killSwitchRoute.PUT, { method: 'PUT', token, body });

  it('reads the default state: global off, nothing frozen/killed/disabled', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json.global).toMatchObject({ enabled: false });
    expect(res.json.disabledProviders).toEqual([]);
    expect(res.json.propagationSec).toBe(30);
  });

  it('engages and releases the global switch, invalidating the cache immediately', async () => {
    const killSwitch = await getKillSwitch();
    expect((await killSwitch.check({ organisationId: 'anyone' })).killed).toBe(false);

    const engaged = await put({ level: 'global', enabled: true, reason: 'incident response' });
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
    await call(killSwitchRoute.PUT, {
      method: 'PUT',
      token: 'staff',
      body: { level: 'global', enabled: true, reason: 'audit check' },
    });
    expect(api.audits.map((a) => a.action)).toContain('studio.kill_switch.engage');
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
});

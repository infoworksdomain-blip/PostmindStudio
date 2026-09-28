import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as channelRoute from '../../src/app/api/studio/internal/channels/[id]/route';
import * as channelsRoute from '../../src/app/api/studio/internal/channels/route';
import * as purgeRoute from '../../src/app/api/studio/internal/organisations/[id]/purge/route';
import * as refreshedRoute from '../../src/app/api/studio/internal/tokens/refreshed/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  formatContractReport,
  parseContractArgs,
  runCoreContract,
} from '../../src/lib/studio/ops/core-contract';
import { ValidationError } from '../../src/lib/errors';
import { installApi } from '../helpers/api-harness';

// BACKLOG 14.10 — the Core contract suite (npm run contract:core) run against Studio's REAL
// internal route handlers in-process, so the suite, the copyable client and the OpenAPI response
// shapes are proven against the code Core will call on staging.

const hasDb = Boolean(process.env.DATABASE_URL);
const SERVICE_TOKEN = 'c'.repeat(48);
const BASE = 'http://studio.test';

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** A fetch that dispatches to the Next route handlers, as the router would. */
function inProcessFetch(): typeof fetch {
  const routes: Array<[RegExp, Partial<Record<string, Handler>>]> = [
    [/^\/api\/studio\/internal\/channels$/, channelsRoute],
    [/^\/api\/studio\/internal\/channels\/([^/]+)$/, channelRoute],
    [/^\/api\/studio\/internal\/tokens\/refreshed$/, refreshedRoute],
    [/^\/api\/studio\/internal\/organisations\/([^/]+)\/purge$/, purgeRoute],
  ];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    for (const [pattern, module] of routes) {
      const match = pattern.exec(path);
      const handler = match && module[req.method];
      if (handler)
        return handler(req, {
          params: Promise.resolve<Record<string, string>>(
            match[1] ? { id: decodeURIComponent(match[1]) } : {},
          ),
        });
    }
    return new Response('{"ok":false,"error":"not_found"}', { status: 404 });
  }) as typeof fetch;
}

describe.skipIf(!hasDb)(
  'Core contract suite against the real handlers',
  { timeout: 60_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const orgs: string[] = [];

    beforeEach(() => {
      vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
      installApi(db, {});
    });
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      setApiDeps(undefined);
      await db.platformConnection.deleteMany({ where: { organisationId: { in: orgs } } });
      await db.organisationPurge.deleteMany({ where: { organisationId: { in: orgs } } });
      await db.systemFlag.deleteMany({
        where: { key: { in: orgs.map((o) => `kill_switch:workspace:${o}`) } },
      });
      await db.$disconnect();
    });

    it('passes every check', async () => {
      const report = await runCoreContract({
        baseUrl: BASE,
        token: SERVICE_TOKEN,
        fetch: inProcessFetch(),
        sleep: async () => undefined,
      });
      orgs.push(report.organisationId);
      const failed = report.checks.filter((c) => !c.ok);
      expect(failed).toEqual([]);
      expect(report.checks).toHaveLength(12);
      expect(report.passed).toBe(true);
      const text = formatContractReport(report);
      expect(text).toContain('12/12 passed');
      // Nothing the suite registered keeps a token: the purge wiped them.
      const rows = await db.platformConnection.findMany({
        where: { organisationId: report.organisationId },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.encryptedAccessToken === '' && r.state === 'revoked')).toBe(true);
    });

    it('reports a disabled internal API and a wrong token clearly', async () => {
      vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', '');
      const disabled = await runCoreContract({
        baseUrl: BASE,
        token: SERVICE_TOKEN,
        fetch: inProcessFetch(),
        sleep: async () => undefined,
      });
      orgs.push(disabled.organisationId);
      expect(disabled.passed).toBe(false);
      expect(disabled.checks[0]?.detail).toMatch(/internal API is disabled/);

      vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
      const wrong = await runCoreContract({
        baseUrl: BASE,
        token: 'x'.repeat(40),
        fetch: inProcessFetch(),
        sleep: async () => undefined,
      });
      orgs.push(wrong.organisationId);
      expect(wrong.checks[1]).toMatchObject({
        ok: false,
        detail: expect.stringMatching(/--token/),
      });
    });
  },
);

describe('parseContractArgs', () => {
  it('reads --base-url / --token (space or =) and falls back to env', () => {
    expect(
      parseContractArgs(['--base-url', 'https://s.internal', `--token=${'a'.repeat(32)}`], {}),
    ).toEqual({
      baseUrl: 'https://s.internal',
      token: 'a'.repeat(32),
    });
    expect(
      parseContractArgs([], {
        STUDIO_CONTRACT_BASE_URL: 'http://x',
        STUDIO_CONTRACT_TOKEN: 'b'.repeat(40),
      }),
    ).toEqual({ baseUrl: 'http://x', token: 'b'.repeat(40) });
  });

  it('refuses a missing URL or a short token', () => {
    expect(() => parseContractArgs(['--token', 'a'.repeat(32)], {})).toThrow(ValidationError);
    expect(() =>
      parseContractArgs(['--base-url', 'ftp://x', '--token', 'a'.repeat(32)], {}),
    ).toThrow(ValidationError);
    expect(() => parseContractArgs(['--base-url', 'https://x', '--token', 'short'], {})).toThrow(
      ValidationError,
    );
  });
});

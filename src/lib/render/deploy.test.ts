import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, UpstreamServiceError, ValidationError } from '../errors';
import {
  assertCommitSha,
  createRenderRequest,
  deployCommit,
  parseServiceIds,
  type DeployCommitDeps,
  type RenderRequest,
  type RenderResponse,
} from './deploy';

const SHA_N = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_N1 = 'ffeeddccbbaa99887766554433221100ffeeddcc';

type Call = { method: string; path: string; body?: Record<string, string> };

/** A fake Render API: per-service deploy history and a queue of statuses per new deploy. */
function fakeRender(opts: {
  history: Record<string, Array<{ id: string; status: string; commit: string }>>;
  statuses?: Record<string, string[]>;
  triggerStatus?: number;
}) {
  const calls: Call[] = [];
  let seq = 0;
  const polls: Record<string, string[]> = { ...opts.statuses };
  const request: RenderRequest = async (method, path, body) => {
    calls.push({ method, path, ...(body && { body }) });
    const [, , serviceId, action, deployId] = path.split('?')[0]!.split('/');
    if (method === 'GET' && action === 'deploys' && !deployId) {
      const list = (opts.history[serviceId!] ?? []).map((d) => ({
        deploy: { id: d.id, status: d.status, commit: { id: d.commit } },
        cursor: 'c',
      }));
      return { status: 200, body: list };
    }
    if (method === 'POST') {
      if (opts.triggerStatus === 202) return { status: 202, body: undefined };
      seq += 1;
      return { status: 201, body: { id: `dep-new${seq}`, status: 'created' } };
    }
    if (method === 'GET' && deployId) {
      const queue = polls[serviceId!] ?? ['live'];
      const status = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { status: 200, body: { id: deployId, status, commit: { id: SHA_N } } };
    }
    return { status: 404, body: undefined } satisfies RenderResponse;
  };
  let clock = 0;
  const deps: DeployCommitDeps = {
    request,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => undefined,
  };
  return { deps, calls };
}

describe('deployCommit', () => {
  it('rolls back to a retained build of the commit instead of rebuilding', async () => {
    const { deps, calls } = fakeRender({
      history: {
        'srv-web': [
          { id: 'dep-3', status: 'live', commit: SHA_N1 },
          { id: 'dep-2', status: 'deactivated', commit: SHA_N },
        ],
      },
      statuses: { 'srv-web': ['update_in_progress', 'live'] },
    });

    const [result] = await deployCommit(deps, { serviceIds: ['srv-web'], commit: SHA_N });

    expect(result).toMatchObject({ mode: 'rollback', ok: true, status: 'live' });
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/services/srv-web/rollback',
      body: { deployId: 'dep-2' },
    });
  });

  it('builds the commit when no retained deploy has it (or --rebuild)', async () => {
    const history = { 'srv-web': [{ id: 'dep-2', status: 'deactivated', commit: SHA_N }] };
    const { deps, calls } = fakeRender({ history });

    const [result] = await deployCommit(deps, {
      serviceIds: ['srv-web'],
      commit: SHA_N,
      rebuild: true,
    });

    expect(result?.mode).toBe('build');
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/services/srv-web/deploys',
      body: { commitId: SHA_N },
    });
  });

  it('accepts a short SHA and treats an already-live commit as done', async () => {
    const { deps, calls } = fakeRender({
      history: { 'srv-web': [{ id: 'dep-9', status: 'live', commit: SHA_N }] },
    });

    const [result] = await deployCommit(deps, { serviceIds: ['srv-web'], commit: 'A1B2C3D' });

    expect(result).toMatchObject({ mode: 'already-live', ok: true });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('deploys the web service first and stops if it fails', async () => {
    const { deps, calls } = fakeRender({
      history: {},
      statuses: { 'srv-web': ['pre_deploy_failed'] },
    });

    const results = await deployCommit(deps, {
      serviceIds: ['srv-web', 'srv-worker1', 'srv-worker2'],
      commit: SHA_N,
    });

    expect(results).toEqual([expect.objectContaining({ serviceId: 'srv-web', ok: false })]);
    expect(calls.some((c) => c.path.includes('srv-worker1'))).toBe(false);
  });

  it('deploys the remaining services after the web service is live', async () => {
    const { deps } = fakeRender({ history: {} });

    const results = await deployCommit(deps, {
      serviceIds: ['srv-web', 'srv-worker1', 'srv-worker2'],
      commit: SHA_N,
    });

    expect(results.map((r) => [r.serviceId, r.ok])).toEqual([
      ['srv-web', true],
      ['srv-worker1', true],
      ['srv-worker2', true],
    ]);
  });

  it('reports a timeout when the deploy never finishes', async () => {
    const { deps } = fakeRender({ history: {}, statuses: { 'srv-web': ['build_in_progress'] } });

    const [result] = await deployCommit(deps, {
      serviceIds: ['srv-web'],
      commit: SHA_N,
      pollMs: 1_000,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ ok: false, status: 'timeout (build_in_progress)' });
  });

  it('fails clearly when Render queues the deploy without an id (HTTP 202)', async () => {
    const { deps } = fakeRender({ history: {}, triggerStatus: 202 });

    await expect(deployCommit(deps, { serviceIds: ['srv-web'], commit: SHA_N })).rejects.toThrow(
      UpstreamServiceError,
    );
  });

  it('rejects a commit that is not a SHA before calling Render', async () => {
    const { deps, calls } = fakeRender({ history: {} });

    await expect(
      deployCommit(deps, { serviceIds: ['srv-web'], commit: 'main; rm -rf /' }),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe('parseServiceIds / assertCommitSha', () => {
  it('parses a comma-separated list of service ids', () => {
    expect(parseServiceIds(' srv-abc123, srv-def456 ')).toEqual(['srv-abc123', 'srv-def456']);
  });

  it.each([undefined, '', 'srv-ok,web'])('rejects %s', (raw) => {
    expect(() => parseServiceIds(raw)).toThrow(ConfigurationError);
  });

  it('lower-cases a valid SHA', () => {
    expect(assertCommitSha('ABCDEF1')).toBe('abcdef1');
  });
});

describe('createRenderRequest', () => {
  it('sends the API key as a Bearer token and parses JSON', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'dep-1', status: 'created' }), { status: 201 }),
    );
    const request = createRenderRequest('rnd_test', fetchImpl as unknown as typeof fetch);

    const res = await request('POST', '/services/srv-web/deploys', { commitId: SHA_N });

    expect(res).toEqual({ status: 201, body: { id: 'dep-1', status: 'created' } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.render.com/v1/services/srv-web/deploys');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer rnd_test');
    expect(init?.body).toBe(JSON.stringify({ commitId: SHA_N }));
  });

  it('returns an undefined body for an empty or non-JSON response', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const request = createRenderRequest('rnd_test', fetchImpl as unknown as typeof fetch);

    await expect(request('GET', '/services/srv-web/deploys')).resolves.toEqual({
      status: 202,
      body: undefined,
    });
  });
});

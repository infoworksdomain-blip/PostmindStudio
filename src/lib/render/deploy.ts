import { ConfigurationError, UpstreamServiceError, ValidationError } from '../errors';

// Deployment: Render. Deploys one Git commit to a set of Render services through the Render REST
// API and waits until every service is live. Used as STAGING_DEPLOY_CMD by the rollback
// rehearsal (scripts/ops/staging-gate.ts --rehearse rollback) and for promoting a verified
// commit to production (runbooks/render-deploy.md).
//
// Endpoints (https://api-docs.render.com/reference, read 2026-09-28):
//   GET  /v1/services/{serviceId}/deploys?limit=N        → [{ deploy, cursor }]
//   POST /v1/services/{serviceId}/deploys { commitId }   → 201 deploy (202 = queued)
//   POST /v1/services/{serviceId}/rollback { deployId }  → 201 deploy
//   GET  /v1/services/{serviceId}/deploys/{deployId}     → deploy { id, commit: { id }, status }
// Deploy statuses: created queued build_in_progress update_in_progress live deactivated
// build_failed update_failed canceled pre_deploy_in_progress pre_deploy_failed.
//
// When the commit was deployed to a service before and its build is still retained, the
// service is ROLLED BACK to that deploy (Render reuses the build artifact,
// https://render.com/docs/rollbacks), which is how a real rollback runs and keeps the rehearsal
// honest against the 5-minute SLO. Otherwise Render builds the commit. Neither API call disables
// auto-deploys (both endpoints say so), so the caller turns auto-deploy off first if needed.
// The first service is deployed on its own (the web service: its pre-deploy command runs the
// migrations), then the rest in parallel (runbooks/deploy.md order of operations).

export const RENDER_API_BASE = 'https://api.render.com/v1';

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const SERVICE_ID = /^srv-[a-z0-9]+$/;
const LIVE = 'live';
const FAILED = new Set([
  'build_failed',
  'update_failed',
  'canceled',
  'pre_deploy_failed',
  'deactivated',
]);
const REUSABLE = new Set(['live', 'deactivated']);

export interface RenderDeploy {
  id: string;
  status: string;
  commitId?: string;
}

export interface RenderResponse {
  status: number;
  body: unknown;
}

export type RenderRequest = (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, string>,
) => Promise<RenderResponse>;

export interface DeployCommitDeps {
  request: RenderRequest;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface DeployCommitOptions {
  serviceIds: string[];
  commit: string;
  /** Force a fresh build even when a retained build of the commit exists. */
  rebuild?: boolean;
  pollMs?: number;
  /** Per service. Render's own limits: build 120 min, pre-deploy 30 min (docs/deploys). */
  timeoutMs?: number;
}

export interface ServiceDeployResult {
  serviceId: string;
  deployId?: string;
  mode: 'rollback' | 'build' | 'already-live';
  status: string;
  ok: boolean;
  elapsedMs: number;
}

export function parseServiceIds(raw: string | undefined): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new ConfigurationError(
      'RENDER_DEPLOY_SERVICE_IDS is required (comma-separated srv-… ids, web service first)',
    );
  }
  const bad = ids.filter((id) => !SERVICE_ID.test(id));
  if (bad.length) throw new ConfigurationError(`not a Render service id: ${bad.join(', ')}`);
  return ids;
}

export function assertCommitSha(commit: string): string {
  const sha = commit.trim().toLowerCase();
  if (!COMMIT_SHA.test(sha)) throw new ValidationError(`not a git commit SHA: "${commit}"`);
  return sha;
}

function toDeploy(value: unknown): RenderDeploy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { id?: unknown; status?: unknown; commit?: { id?: unknown } | null };
  if (typeof v.id !== 'string' || typeof v.status !== 'string') return undefined;
  const commitId = typeof v.commit?.id === 'string' ? v.commit.id.toLowerCase() : undefined;
  return { id: v.id, status: v.status, ...(commitId && { commitId }) };
}

function expectOk(res: RenderResponse, what: string, ok: number[]): void {
  if (!ok.includes(res.status)) {
    throw new UpstreamServiceError(`Render API ${what} returned HTTP ${res.status}`);
  }
}

async function listDeploys(request: RenderRequest, serviceId: string): Promise<RenderDeploy[]> {
  const res = await request('GET', `/services/${serviceId}/deploys?limit=100`);
  expectOk(res, `list deploys (${serviceId})`, [200]);
  if (!Array.isArray(res.body)) return [];
  return res.body
    .map((item) => toDeploy((item as { deploy?: unknown } | null)?.deploy))
    .filter((d): d is RenderDeploy => d !== undefined);
}

function matchesCommit(deploy: RenderDeploy, commit: string): boolean {
  return deploy.commitId !== undefined && deploy.commitId.startsWith(commit);
}

async function start(
  deps: DeployCommitDeps,
  serviceId: string,
  commit: string,
  rebuild: boolean,
): Promise<{ mode: ServiceDeployResult['mode']; deploy: RenderDeploy }> {
  const history = await listDeploys(deps.request, serviceId); // newest first
  const current = history.find((d) => d.status === LIVE);
  if (current && matchesCommit(current, commit)) return { mode: 'already-live', deploy: current };

  const retained = rebuild
    ? undefined
    : history.find((d) => REUSABLE.has(d.status) && matchesCommit(d, commit));
  const res = retained
    ? await deps.request('POST', `/services/${serviceId}/rollback`, { deployId: retained.id })
    : await deps.request('POST', `/services/${serviceId}/deploys`, { commitId: commit });
  const what = retained ? `rollback (${serviceId})` : `trigger deploy (${serviceId})`;
  expectOk(res, what, [201, 202]);
  const deploy = toDeploy(res.body);
  if (!deploy) {
    // 202 = another deploy is in progress and this one is queued without an id (docs).
    throw new UpstreamServiceError(
      `Render API ${what} did not return a deploy id (HTTP ${res.status}); another deploy is probably in progress — wait for it and retry`,
    );
  }
  return { mode: retained ? 'rollback' : 'build', deploy };
}

async function waitLive(
  deps: DeployCommitDeps,
  serviceId: string,
  deployId: string,
  pollMs: number,
  deadline: number,
): Promise<string> {
  for (;;) {
    const res = await deps.request('GET', `/services/${serviceId}/deploys/${deployId}`);
    expectOk(res, `retrieve deploy (${serviceId})`, [200]);
    const status = toDeploy(res.body)?.status ?? 'unknown';
    if (status === LIVE || FAILED.has(status)) return status;
    if (deps.now() >= deadline) return `timeout (${status})`;
    await deps.sleep(pollMs);
  }
}

async function deployService(
  deps: DeployCommitDeps,
  serviceId: string,
  opts: Required<Pick<DeployCommitOptions, 'commit' | 'rebuild' | 'pollMs' | 'timeoutMs'>>,
): Promise<ServiceDeployResult> {
  const startedAt = deps.now();
  const { mode, deploy } = await start(deps, serviceId, opts.commit, opts.rebuild);
  deps.log(`${serviceId}: ${mode === 'already-live' ? 'already live' : mode} ${deploy.id}`);
  const status =
    mode === 'already-live'
      ? LIVE
      : await waitLive(deps, serviceId, deploy.id, opts.pollMs, startedAt + opts.timeoutMs);
  const result = {
    serviceId,
    deployId: deploy.id,
    mode,
    status,
    ok: status === LIVE,
    elapsedMs: deps.now() - startedAt,
  };
  deps.log(`${serviceId}: ${status} after ${Math.round(result.elapsedMs / 1000)} s`);
  return result;
}

/** Deploy `commit` to every service (first one alone, then the rest in parallel). */
export async function deployCommit(
  deps: DeployCommitDeps,
  options: DeployCommitOptions,
): Promise<ServiceDeployResult[]> {
  const commit = assertCommitSha(options.commit);
  const opts = {
    commit,
    rebuild: options.rebuild ?? false,
    pollMs: options.pollMs ?? 10_000,
    timeoutMs: options.timeoutMs ?? 45 * 60_000,
  };
  const [first, ...rest] = options.serviceIds;
  if (!first) throw new ConfigurationError('no Render services to deploy');
  const head = await deployService(deps, first, opts);
  if (!head.ok) return [head];
  const tail = await Promise.all(rest.map((id) => deployService(deps, id, opts)));
  return [head, ...tail];
}

/** fetch-based RenderRequest (Bearer API key). The key is never logged or put in an error. */
export function createRenderRequest(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  base: string = RENDER_API_BASE,
): RenderRequest {
  return async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }
    return { status: res.status, body: parsed };
  };
}

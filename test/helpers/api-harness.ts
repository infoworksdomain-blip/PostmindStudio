import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '../../src/lib/errors';
import type { AuditEntry } from '../../src/lib/audit';
import { setApiDeps, type ApiDeps } from '../../src/lib/studio/api/context';
import { createMemoryIdempotencyStore } from '../../src/lib/studio/api/idempotency';
import { randomBytes } from 'node:crypto';
import { createLocalKeyProvider } from '../../src/lib/studio/crypto/envelope';
import type { OAuthClient } from '../../src/lib/studio/platforms/oauth';
import { createMemoryOAuthStateStore } from '../../src/lib/studio/platforms/oauth-state';
import type { PublishingDeps } from '../../src/lib/studio/platforms/publishing';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { libraryDepsFrom } from '../../src/lib/studio/images/library';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { fakePublisherRegistry } from './fake-publishers';
import { createHarness } from './pipeline-harness';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import type { TenantContext } from '../../src/lib/tenant';
import { memoryStorage } from './memory-storage';
import { ScriptedAdapter } from './scripted-adapter';

// Installs ApiDeps for route-handler tests: real Prisma, inline queue, memory storage, and a
// token → tenant map standing in for PostMind Core JWT verification.

export const ALL_CAPABILITIES = [
  'studio:project:read',
  'studio:project:write',
  'studio:project:approve',
  'studio:render:download',
  'studio:render:force-approve',
  'studio:publication:write',
  'studio:connections:manage',
];

export function tenant(
  organisationId: string,
  capabilities = ALL_CAPABILITIES,
  userId = 'user-1',
): TenantContext {
  return {
    userId,
    organisationId,
    organisation: { id: organisationId, planTier: 'STANDARD' },
    memberships: [{ organisationId, role: 'owner' }],
    capabilities,
  };
}

export const APP_URL = 'http://studio.test';

export interface InstallOptions {
  /** Share a pipeline harness's queue so tests can drain jobs the API enqueued. */
  queue?: InlineJobQueue;
  /** Share a pipeline harness's publishing deps (publishers, keys, storage). */
  publishing?: PublishingDeps;
  /** Pipeline deps backing the image library (provider router, storage, stock sources). */
  pipeline?: PipelineDeps;
}

export function installApi(
  db: PrismaClient,
  tokens: Record<string, TenantContext | 'forbidden'>,
  options: InstallOptions = {},
) {
  const queue = options.queue ?? new InlineJobQueue();
  const storage = options.publishing?.storage ?? memoryStorage().storage;
  const oauthClients = new Map<string, OAuthClient>();
  const publishing: PublishingDeps = options.publishing ?? {
    db,
    publishers: fakePublisherRegistry(),
    meta: { getCredentials: vi.fn(async () => ({ accessToken: 'meta', accountId: 'meta' })) },
    keys: createLocalKeyProvider(randomBytes(32).toString('base64'), 'test'),
    oauth: (platform) => {
      const client = oauthClients.get(platform);
      if (!client) throw new Error(`no fake oauth client for ${platform}`);
      return client;
    },
    storage,
    engagement: { attributePublication: async () => undefined },
    logger: pino({ level: 'silent' }),
    now: Date.now,
  };
  const oauthState = createMemoryOAuthStateStore();
  const audits: AuditEntry[] = [];
  const runway = new ScriptedAdapter('runway', ['text_to_video'], () => ({ state: 'running' }));
  const deps: ApiDeps = {
    db,
    queue,
    storage,
    registry: createProviderRegistry([runway]),
    resolveTenant: vi.fn(async (req: Pick<Request, 'headers'>) => {
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
      const entry = token ? tokens[token] : undefined;
      if (!entry) throw new UnauthorizedError('Missing or invalid token');
      if (entry === 'forbidden') throw new ForbiddenError('No membership');
      return entry;
    }),
    audit: (entry) => audits.push(entry),
    idempotency: createMemoryIdempotencyStore(),
    publishing,
    oauthState,
    library: libraryDepsFrom(options.pipeline ?? createHarness(db).deps),
    appUrl: APP_URL,
    fontsBaseUrl: 'https://fonts.test',
    logger: pino({ level: 'silent' }),
    now: Date.now,
  };
  setApiDeps(deps);
  return { deps, queue, audits, storage, runway, publishing, oauthState, oauthClients };
}

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export async function call(
  handler: Handler,
  options: {
    method?: string;
    path?: string;
    token?: string;
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await rawCall(handler, options);
  const text = await res.text();
  return {
    status: res.status,
    json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    headers: res.headers,
  };
}

export async function rawCall(
  handler: Handler,
  options: {
    method?: string;
    path?: string;
    token?: string;
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined && !headers['content-type'])
    headers['content-type'] = 'application/json';
  const req = new Request(`${APP_URL}${options.path ?? '/api/studio/test'}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string' || options.body instanceof Uint8Array
          ? (options.body as BodyInit)
          : JSON.stringify(options.body),
  });
  return handler(req, { params: Promise.resolve(options.params ?? {}) });
}

/** Encode a FormData as a multipart body with explicit content-type and content-length. */
export async function multipart(
  form: FormData,
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const req = new Request('http://multipart.local', { method: 'POST', body: form });
  const body = new Uint8Array(await req.arrayBuffer());
  return {
    body,
    headers: {
      'content-type': req.headers.get('content-type') ?? '',
      'content-length': String(body.byteLength),
    },
  };
}

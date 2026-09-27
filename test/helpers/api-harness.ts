import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '../../src/lib/errors';
import type { AuditEntry } from '../../src/lib/audit';
import { setApiDeps, type ApiDeps } from '../../src/lib/studio/api/context';
import { createMemoryIdempotencyStore } from '../../src/lib/studio/api/idempotency';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import type { TenantContext } from '../../src/lib/tenant';
import { memoryStorage } from './memory-storage';
import { ScriptedAdapter } from './scripted-adapter';

// Installs ApiDeps for route-handler tests: real Prisma, inline queue, memory storage, and a
// token → tenant map standing in for PostMind Core JWT verification.

export const ALL_CAPABILITIES = [
  'studio:project:read',
  'studio:project:write',
  'studio:render:download',
  'studio:render:force-approve',
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

export function installApi(db: PrismaClient, tokens: Record<string, TenantContext | 'forbidden'>) {
  const queue = new InlineJobQueue();
  const { storage } = memoryStorage();
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
    logger: pino({ level: 'silent' }),
    now: Date.now,
  };
  setApiDeps(deps);
  return { deps, queue, audits, storage, runway };
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
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`http://studio.test${options.path ?? '/api/studio/test'}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
  });
  const res = await handler(req, { params: Promise.resolve(options.params ?? {}) });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

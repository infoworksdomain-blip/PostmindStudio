// In-browser stand-in for /api/studio in the demo build. Handlers return the same envelopes the
// real routes return (`{ ok: true, ...body }` / `{ ok: false, error, message }`), with a short
// latency so loading states are visible. Unknown routes answer 501 and are logged, so a screen
// that calls something the demo doesn't cover shows its real error state instead of fake data.
import { handleAuth } from './auth';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface HandlerContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  method: Method;
}

export interface HandlerResult {
  status?: number;
  body: Record<string, unknown>;
}

export class DemoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Handler = (
  ctx: HandlerContext,
) => HandlerResult | Record<string, unknown> | Promise<HandlerResult | Record<string, unknown>>;

interface Route {
  method: Method;
  parts: string[];
  handler: Handler;
}

const routes: Route[] = [];
export const unhandled = new Set<string>();

/**
 * A check every request passes before its handler, as the real API's route wrapper runs the
 * billing access gate (demo/api/billing-state.ts registers the demo's). Throw DemoHttpError to
 * refuse; the body is the parsed JSON (or FormData).
 */
export type RequestGate = (req: { method: Method; path: string; body: unknown }) => void;

let requestGate: RequestGate | null = null;

export function setRequestGate(gate: RequestGate): void {
  requestGate = gate;
}

function errorResponse(err: DemoHttpError): Response {
  return json(err.status, {
    ok: false,
    error: err.code,
    message: err.message,
    details: err.details,
  });
}

export function route(method: Method, pattern: string, handler: Handler): void {
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
}

function match(r: Route, path: string[]): Record<string, string> | null {
  if (r.parts.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < r.parts.length; i++) {
    const seg = r.parts[i] as string;
    const val = path[i] as string;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

function isResult(v: HandlerResult | Record<string, unknown>): v is HandlerResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    'body' in v &&
    typeof (v as HandlerResult).body === 'object' &&
    Object.keys(v).every((k) => k === 'body' || k === 'status')
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(init?: RequestInit): Promise<unknown> {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof FormData) return body;
  return undefined;
}

export async function handle(url: URL, init?: RequestInit): Promise<Response> {
  const method = ((init?.method ?? 'GET').toUpperCase() as Method) || 'GET';
  const path = url.pathname
    .replace(/^\/api\/studio/, '')
    .split('/')
    .filter(Boolean);
  await sleep(method === 'GET' ? 120 + Math.random() * 180 : 250 + Math.random() * 250);
  const body = await readBody(init);
  try {
    requestGate?.({ method, path: `/${path.join('/')}`, body });
  } catch (err) {
    if (err instanceof DemoHttpError) return errorResponse(err);
    throw err;
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = match(r, path);
    if (!params) continue;
    try {
      const out = await r.handler({ params, query: url.searchParams, body, method });
      const result = isResult(out) ? out : { body: out };
      return json(result.status ?? 200, { ok: true, ...result.body });
    } catch (err) {
      if (err instanceof DemoHttpError) return errorResponse(err);
      // eslint-disable-next-line no-console -- the demo's only diagnostics channel
      console.error('[demo api]', method, url.pathname, err);
      return json(500, { ok: false, error: 'internal_error', message: 'Demo handler failed' });
    }
  }
  const key = `${method} ${url.pathname}`;
  if (!unhandled.has(key)) {
    unhandled.add(key);
    // eslint-disable-next-line no-console -- flags screens calling routes the demo doesn't cover
    console.warn('[demo api] not covered by the demo:', key);
  }
  return json(501, {
    ok: false,
    error: 'not_in_demo',
    message: 'This action is not wired up in the demo build.',
  });
}

export function installMockFetch(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The artifact frame's own URL may not be a usable base (e.g. about:srcdoc).
    const url = new URL(raw, 'https://studio.demo');
    if (url.pathname.startsWith('/api/studio')) return handle(url, init);
    // Phase 18 Track A screens call Better Auth directly (demo/api/auth.ts).
    if (url.pathname.startsWith('/api/auth/')) return handleAuth(url, init);
    return realFetch(input, init);
  };
}

import { ValidationError } from '../../errors';
import type { BusinessGuard } from '../core/select';
import { businessIdParam } from '../services/businesses';

// Phase 18 §2.11 — "assertBusinessInOrg on every write route that takes a businessId". Rather than
// trusting ~30 route handlers to remember it, withStudioRoute runs this on every mutating request
// when businesses are local (ApiDeps.businessGuard). The ids a write can name:
//   - the path: /api/studio/businesses/:id/… (business profile, scans, drip queue, style memory…)
//   - a top-level `businessId` in a JSON body (projects, brand kits, uploads, connections…)
//   - a `businessId` query parameter
// Each must be a live business of the caller's organisation, else 404 (a business of another
// organisation looks exactly like a missing one).

const BUSINESS_PATH = /^\/api\/studio\/businesses\/([^/]+)(?:\/|$)/;
const MAX_INSPECTED_BODY = 1_000_000;

async function bodyBusinessId(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (type && !type.includes('json')) return undefined; // multipart uploads name none at top level
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_INSPECTED_BODY) return undefined;
  const text = await req.clone().text();
  if (!text.trim() || text.length > MAX_INSPECTED_BODY) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).businessId
      : undefined;
  } catch {
    return undefined; // the handler's own parseBody answers the 400
  }
}

/** The distinct business ids a request names (malformed ones are 400s). */
export async function businessIdsInRequest(req: Request): Promise<string[]> {
  const url = new URL(req.url);
  const candidates: unknown[] = [];
  const fromPath = BUSINESS_PATH.exec(url.pathname)?.[1];
  if (fromPath !== undefined) candidates.push(decodeURIComponent(fromPath));
  const fromQuery = url.searchParams.get('businessId');
  if (fromQuery !== null) candidates.push(fromQuery);
  const fromBody = await bodyBusinessId(req);
  if (fromBody !== undefined && fromBody !== null) candidates.push(fromBody);
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const parsed = businessIdParam.safeParse(candidate);
    if (!parsed.success) throw new ValidationError('businessId must be 1-128 characters');
    ids.add(parsed.data);
  }
  return [...ids];
}

export async function guardBusinessIds(
  guard: BusinessGuard,
  organisationId: string,
  req: Request,
): Promise<void> {
  for (const businessId of await businessIdsInRequest(req)) await guard(organisationId, businessId);
}

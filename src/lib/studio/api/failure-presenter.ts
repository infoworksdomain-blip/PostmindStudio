import { parseFailure, UNKNOWN_FAILURE, type ParsedFailure } from '../../client/failure-reasons';
import type { TenantContext } from '../../tenant';

// QA 3: one presenter for every API response. A stored failure reason is `<code>: <text>` where the
// text can be a provider's or platform's own words (hostnames, tokens, ECONNREFUSED). A customer's
// browser gets only the reason code and its parameters (what the translated sentence is built
// from); platform staff get the stored text. Applied once, in withStudioRoute, to every body, so a
// new route cannot forget it.

/** Platform staff (users.role staff | superadmin) read raw reasons; everyone else does not. */
export function mayReadRawFailures(tenant: Pick<TenantContext, 'platformRole'>): boolean {
  return tenant.platformRole === 'staff' || tenant.platformRole === 'superadmin';
}

/** The reason rebuilt from what the client needs to render its sentence, without provider text. */
function canonical(p: ParsedFailure): string {
  const { code, params } = p;
  switch (code) {
    case 'provider_failure':
      return `${params.source ?? 'provider'}/${params.errorClass ?? 'unknown'}:`;
    case 'kill_switch':
      return `kill_switch_${params.level ?? 'global'}`;
    case 'asset_generation_failed':
      return `${code}: ${(params.shots ?? []).map((n) => `shot ${n}:`).join('; ')}`;
    case 'quality_failed':
    case 'content_safety_block':
      return `${code}: ${(params.checks ?? []).map((c) => `${c.platform}/${c.check}:`).join('; ')}`;
    case 'scan_cost_cap':
    case 'scan_images_capped':
      return params.pence === undefined
        ? code
        : `${code}: Stopped at the scan cost cap (${params.pence}p)${code === 'scan_images_capped' ? ': some images were not indexed' : ''}`;
    case 'scan_pages_skipped':
    case 'scan_images_skipped':
      return params.count === undefined ? code : `${code}: ${params.count}`;
    default:
      if (p.cause) return `${code}: ${canonical(p.cause)}`;
      // Text written by Studio or a reviewer (a safety note, a rejection note) stays; a wrapper's
      // uncoded cause is raw text from elsewhere and goes.
      return p.detail ? `${code}: ${p.detail}` : code;
  }
}

/** A stored reason without provider / platform text; unknown reasons become UNKNOWN_FAILURE. */
export function redactFailureReason(raw: string): string {
  const parsed = parseFailure(raw);
  return parsed ? canonical(parsed) : UNKNOWN_FAILURE;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value === null || typeof value !== 'object') return value;
  // Dates, Decimals and other class instances serialise themselves (toJSON); only plain data is walked.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const source = value as Record<string, unknown>;
  const isScan = 'robotsBlocked' in source;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'errorReason' && typeof child === 'string') out[key] = redactFailureReason(child);
    else if (key === 'errors' && isScan && Array.isArray(child))
      out[key] = child.map((e) => (typeof e === 'string' ? redactFailureReason(e) : e));
    else out[key] = walk(child);
  }
  return out;
}

/** The response body as the caller may see it: raw failure text only for platform staff. */
export function presentBody<T>(body: T, tenant: Pick<TenantContext, 'platformRole'>): T {
  return mayReadRawFailures(tenant) ? body : (walk(body) as T);
}

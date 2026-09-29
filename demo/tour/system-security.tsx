import { DEMO_ORG_ID, DEMO_USER_ID } from '../api/ids';
import { Chapter, Code, DataTable, Panel } from './ui';

// Behind the scenes, part 3: rate limiting, security, internal (Core → Studio) endpoints.
// Sources: api/rate-limit.ts + errors.ts (toErrorResponse, Retry-After), tenant.ts (RS256),
// api/idempotency.ts, platforms/tokens.ts (sealTokens), api/internal.ts,
// app/api/studio/internal/** + services/meta-channels.ts (publicChannel).

const RATE_LIMITED = `HTTP/1.1 429 Too Many Requests
Retry-After: 37
Content-Type: application/json

{
  "ok": false,
  "error": "rate_limited",
  "message": "Too many requests — slow down",
  "details": { "limit": 120, "scope": "user" }
}`;

const REGISTER_REQ = `POST /api/studio/internal/channels
X-Service-Token: <STUDIO_INTERNAL_SERVICE_TOKEN>      # not a JWT; private ingress only
Content-Type: application/json

{
  "organisationId": "${DEMO_ORG_ID}",
  "platform": "instagram",
  "platformAccountId": "17841400000000001",
  "platformAccountName": "leedssourdough",
  "accessToken": "<long-lived page token>",
  "tokenExpiresAt": null,
  "scopes": ["instagram_basic", "instagram_content_publish", "instagram_manage_insights"],
  "connectedByUserId": "${DEMO_USER_ID}"
}`;

const REGISTER_RES = `HTTP/1.1 201 Created          (200 when the channel already existed)

{
  "ok": true,
  "channel": {
    "id": "conn-instagram",
    "organisationId": "${DEMO_ORG_ID}",
    "businessId": null,
    "platform": "instagram",
    "platformAccountId": "17841400000000001",
    "platformAccountName": "leedssourdough",
    "accessTokenExpiresAt": null,
    "scopes": ["instagram_basic", "instagram_content_publish", "instagram_manage_insights"],
    "state": "active",
    "connectedAt": "2026-09-27T08:02:11.000Z"
  },
  "created": true
}
# The token is never returned or logged. Audited as studio.connection.meta_register
# by system:postmind-core.`;

const REFRESH = `POST /api/studio/internal/tokens/refreshed      # Core's nightly refresh, ≤ 100 per call
{ "channels": [ { "organisationId": "${DEMO_ORG_ID}", "platform": "instagram",
                  "platformAccountId": "17841400000000001", "accessToken": "<new token>" },
                { "organisationId": "${DEMO_ORG_ID}", "platform": "facebook",
                  "platformAccountId": "100000000000009", "accessToken": "<new token>" } ] }

200 { "ok": true, "results": [
  { "platform": "instagram", "platformAccountId": "17841400000000001",
    "organisationId": "${DEMO_ORG_ID}", "result": "updated", "id": "conn-instagram" },
  { "platform": "facebook", "platformAccountId": "100000000000009",
    "organisationId": "${DEMO_ORG_ID}", "result": "not_found" } ] }`;

const SECURITY: [string, string][] = [
  [
    'Tokens from PostMind Core',
    'JWT verified against Core’s JWKS, pinned to RS256 (an ES256 token from a trusted key is refused); issuer, audience and expiry enforced; org context from Core, cached 5 min.',
  ],
  [
    'Session cookie + CSRF',
    'Bearer or the PostMind session cookie; cookie-authenticated writes must pass a same-origin check (Origin / Sec-Fetch-Site).',
  ],
  [
    'Capabilities',
    'Every route: tenant → capability → handler. Approving needs studio:project:approve, so editors can’t self-approve; admin routes also need a PostMind staff organisation.',
  ],
  [
    'Idempotency-Key',
    'Reserved in Redis before the handler runs (24 h); a concurrent duplicate gets 409, a reused key with a different body 422.',
  ],
  [
    'Envelope-encrypted tokens',
    'Platform OAuth tokens sealed with AES-256-GCM under a KMS data key; the encryption context binds organisation, platform and token kind.',
  ],
  [
    'SSRF guard',
    'Website scans and library downloads: http/https on 80/443 only, non-public IPs refused at DNS lookup, redirects re-validated per hop.',
  ],
  [
    'Audit trail',
    'Every mutation posts to PostMind’s audit service (fire-and-forget, 3 attempts).',
  ],
];

export function SecurityChapters() {
  return (
    <>
      <Chapter
        id="rate-limits"
        index="07"
        title="API rate limiting"
        description="Fixed one-minute windows in Redis (atomic INCR + EXPIRE), applied after authentication. If Redis is down it fails open and logs; business quotas still apply."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Limits (env overridable)">
            <DataTable
              head={['Who', 'Requests', 'Per minute']}
              rows={[
                ['Each user', 'reads (GET/HEAD)', '600'],
                ['Each user', 'writes (POST/PATCH/…)', '120'],
                ['Each organisation', 'all', '3,000'],
                ['PostMind Core (internal)', 'all', '600'],
              ]}
            />
          </Panel>
          <Code label="sample: the 121st write in a minute">{RATE_LIMITED}</Code>
        </div>
      </Chapter>

      <Chapter
        id="security"
        index="08"
        title="Security"
        description="Studio never issues tokens; it verifies Core’s."
      >
        <dl className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          {SECURITY.map(([k, v]) => (
            <div key={k} className="border-t border-border pt-3">
              <dt className="text-sm font-semibold">{k}</dt>
              <dd className="mt-1 text-sm text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </Chapter>

      <Chapter
        id="internal"
        index="09"
        title="Meta channels: internal endpoints"
        description="Core owns the Instagram / Facebook OAuth and pushes the tokens to Studio. Service token compared in constant time (unset or short token → every internal endpoint answers 404); bodies ≤ 64 KB (413); zod-validated without echoing values."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Code label="request">{REGISTER_REQ}</Code>
          <Code label="response">{REGISTER_RES}</Code>
          <Code label="token refresh batch">{REFRESH}</Code>
          <Panel title="Also">
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <code className="break-all text-foreground">
                  DELETE /api/studio/internal/channels/:id
                </code>{' '}
                or{' '}
                <code className="break-all text-foreground">
                  ?organisationId=&platform=&platformAccountId=
                </code>{' '}
                disconnects and wipes the token (Meta rows only).
              </li>
              <li>
                A refresh re-activates a <code>needs_reconnect</code> channel but never a{' '}
                <code>revoked</code> one.
              </li>
              <li>
                Meta error 190 during publish, metrics or takedown flags the channel{' '}
                <code>needs_reconnect</code>; Studio never refreshes Meta tokens itself.
              </li>
              <li>Single-channel refresh: 404 when unregistered, 409 when disconnected.</li>
            </ul>
          </Panel>
        </div>
      </Chapter>
    </>
  );
}

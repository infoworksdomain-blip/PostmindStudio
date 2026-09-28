import { z } from 'zod';
import { businessPurgeInput } from '../services/business-purge';
import { businessIdParam } from '../services/businesses';
import { fromContentInput } from '../services/content-projects';
import { attributeConversationInput, publicationIdParam } from '../services/conversations';
import { PURGE_GRACE_DAYS } from '../services/organisation-purge';
import { organisationIdParam } from '../services/org-policy';
import {
  accountRefInput,
  MAX_REFRESH_BATCH,
  refreshedTokensInput,
  registerMetaChannelInput,
} from '../services/meta-channels';
import { INTERNAL_MAX_BODY_BYTES, INTERNAL_TOKEN_MIN_LENGTH } from './internal';

// BACKLOG 14.10 — the contract of Studio's service-to-service API (/api/studio/internal/**) that
// PostMind Core calls, as one table. The REQUEST schemas are the very zod schemas the route
// handlers validate with (services/meta-channels.ts, services/org-policy.ts); the RESPONSE
// schemas below describe what the handlers return and are checked against the real handlers in
// test/api/internal-contract.test.ts. buildInternalOpenApi() turns the table into the OpenAPI 3.1
// document committed at integrations/core/openapi.json (regenerate with
// `npx tsx scripts/core/generate-openapi.ts`; test/integrations/openapi-drift.test.ts fails when
// the committed file, the zod schemas or the route files disagree).

export const publicChannelSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  /** null = org-wide (Meta channels Core registers without a businessId). */
  businessId: z.string().nullable(),
  platform: z.string(),
  platformAccountId: z.string(),
  platformAccountName: z.string(),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  scopes: z.array(z.string()),
  state: z.enum(['active', 'needs_reconnect', 'revoked']),
  connectedAt: z.iso.datetime({ offset: true }),
});

export const refreshResultSchema = z.object({
  platform: z.string(),
  platformAccountId: z.string(),
  organisationId: z.string(),
  result: z.enum(['updated', 'not_found', 'revoked']),
  /** Studio's channel id; absent when not_found. */
  id: z.string().optional(),
});

export const purgeResultSchema = z.object({
  organisationId: z.string(),
  channelsWiped: z.number().int(),
  projectsDeleted: z.number().int(),
  publicationsCancelled: z.number().int(),
  requestedAt: z.iso.datetime({ offset: true }),
  graceUntil: z.iso.datetime({ offset: true }),
  /** True when Core had already asked for this organisation's purge. */
  repeated: z.boolean(),
});

export const registerResponseSchema = z.object({
  ok: z.literal(true),
  channel: publicChannelSchema,
  created: z.boolean(),
});
export const disconnectResponseSchema = z.object({
  ok: z.literal(true),
  disconnected: z.literal(true),
  channel: publicChannelSchema,
});
export const refreshSingleResponseSchema = z.object({
  ok: z.literal(true),
  result: refreshResultSchema,
});
export const refreshBatchResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(refreshResultSchema),
});
export const purgeResponseSchema = z.object({ ok: z.literal(true), purge: purgeResultSchema });

/** 15.E2 — services/business-purge.ts BusinessPurgeResult. */
export const businessPurgeResultSchema = z.object({
  organisationId: z.string(),
  businessId: z.string(),
  projectsDeleted: z.number().int(),
  publicationsCancelled: z.number().int(),
  styleMemoriesDeleted: z.number().int(),
  channelsWiped: z.number().int(),
  requestedAt: z.iso.datetime({ offset: true }),
  graceUntil: z.iso.datetime({ offset: true }),
  /** True when Core had already asked for this business's purge. */
  repeated: z.boolean(),
});
export const businessPurgeResponseSchema = z.object({
  ok: z.literal(true),
  purge: businessPurgeResultSchema,
});

/** 15.E3 — services/conversations.ts AttributionResult. */
export const attributionResultSchema = z.object({
  attributed: z.literal(true),
  publicationId: z.string(),
  conversationId: z.string(),
  isLead: z.boolean(),
  /** True when this conversation was already attributed (idempotent repeat). */
  repeated: z.boolean(),
});
export const attributionResponseSchema = attributionResultSchema.extend({ ok: z.literal(true) });

/** 15.W1 — services/content-projects.ts createProjectFromContent (201 once Core ships). */
export const fromContentProjectSchema = z.object({
  id: z.string(),
  /** Always DRAFT: the user reviews and generates the project from Studio. */
  state: z.string(),
  /** The Core content id the project was made from. */
  sourceRef: z.string().nullable(),
});
export const fromContentResponseSchema = z.object({
  ok: z.literal(true),
  project: fromContentProjectSchema,
});

/** The Engagement error envelope every Studio endpoint uses (src/lib/errors.ts). */
export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  message: z.string().optional(),
  details: z
    .object({
      issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

/** DELETE /internal/channels/:id reads organisationId raw (trimmed; empty = not given). */
export const disconnectByIdQuery = z.object({ organisationId: z.string().optional() });

type Method = 'get' | 'post' | 'put' | 'delete';

interface ResponseSpec {
  description: string;
  schema: z.ZodType;
}

export interface InternalOperation {
  operationId: string;
  method: Method;
  /** OpenAPI path template, e.g. /api/studio/internal/channels/{id}. */
  path: string;
  summary: string;
  description: string;
  pathParams?: Array<{ name: string; description: string; schema: z.ZodType }>;
  query?: z.ZodObject;
  requestBody?: z.ZodType;
  responses: Record<string, ResponseSpec>;
}

const err = (description: string): ResponseSpec => ({ description, schema: errorResponseSchema });

/** Responses every internal operation can return. */
export const COMMON_ERRORS: Record<string, ResponseSpec> = {
  '401': err('Missing or wrong X-Service-Token.'),
  '404': err(
    'Not found — also the answer for EVERY path when STUDIO_INTERNAL_SERVICE_TOKEN is unset on Studio (internal API disabled).',
  ),
  '429': err(
    'Rate limited (STUDIO_INTERNAL_RATE_LIMIT_PER_MIN, default 600/min). Retry after the Retry-After header (seconds).',
  ),
  '500': err('Studio error ({ ok: false, error: "internal_error" }). Retry with backoff.'),
  '503': err('Studio unavailable (deploy / load balancer). Retry with backoff.'),
};

const idParam = (description: string, schema: z.ZodType) => ({ name: 'id', description, schema });

export const INTERNAL_OPERATIONS: InternalOperation[] = [
  {
    operationId: 'registerChannel',
    method: 'post',
    path: '/api/studio/internal/channels',
    summary: 'Register (or re-register) a Meta channel after Core’s OAuth token exchange',
    description:
      'Engagement handover 9.5 step 7. Idempotent upsert on (organisationId, platform, platformAccountId): 201 when created, 200 when it already existed (the token is replaced and the channel re-activated). The token is stored envelope-encrypted and never returned. String fields are trimmed; unknown fields are ignored.',
    requestBody: registerMetaChannelInput,
    responses: {
      '200': { description: 'Already registered: updated.', schema: registerResponseSchema },
      '201': { description: 'Registered.', schema: registerResponseSchema },
      '400': err('Body failed validation (details.issues: path + message, never values).'),
      '413': err(`Body larger than ${INTERNAL_MAX_BODY_BYTES} bytes.`),
    },
  },
  {
    operationId: 'disconnectChannelByAccount',
    method: 'delete',
    path: '/api/studio/internal/channels',
    summary: 'Disconnect a Meta channel by account (tokens wiped)',
    description:
      'For callers that did not keep Studio’s channel id. Idempotent: disconnecting an already revoked channel returns 200 again.',
    query: accountRefInput,
    responses: {
      '200': { description: 'Disconnected (or already).', schema: disconnectResponseSchema },
      '400': err('organisationId, platform and platformAccountId are required.'),
      '404': err('No such channel (or the internal API is disabled).'),
    },
  },
  {
    operationId: 'disconnectChannel',
    method: 'delete',
    path: '/api/studio/internal/channels/{id}',
    summary: 'Disconnect a Meta channel by Studio channel id (tokens wiped)',
    description:
      'The id is the channel.id POST /internal/channels returned. The optional organisationId must match when given. Only Meta channels (instagram, facebook). Idempotent.',
    pathParams: [idParam('Studio channel id (channel.id from registerChannel).', z.string())],
    query: disconnectByIdQuery,
    responses: {
      '200': { description: 'Disconnected (or already).', schema: disconnectResponseSchema },
      '404': err('No such Meta channel for this organisation (or the internal API is disabled).'),
    },
  },
  {
    operationId: 'pushRefreshedTokens',
    method: 'post',
    path: '/api/studio/internal/tokens/refreshed',
    summary: 'Push tokens Core’s nightly job refreshed (one, or a batch of up to 100)',
    description: `Engagement handover 9.6 / 14.13. Single form: 200 { result } when updated, 404 when the channel was never registered, 409 when it was disconnected (register again to reconnect). Batch form { channels: [≤${MAX_REFRESH_BATCH}] }: always 200 with a per-channel result (updated | not_found | revoked). A needs_reconnect channel becomes active again. Idempotent.`,
    requestBody: refreshedTokensInput,
    responses: {
      '200': {
        description: 'Single: { result }. Batch: { results }.',
        schema: z.union([refreshSingleResponseSchema, refreshBatchResponseSchema]),
      },
      '400': err('Body failed validation.'),
      '404': err('Single form: channel not registered; POST /internal/channels first.'),
      '409': err('Single form: channel was disconnected; register it again to reconnect.'),
      '413': err(`Body larger than ${INTERNAL_MAX_BODY_BYTES} bytes.`),
    },
  },
  {
    operationId: 'purgeOrganisation',
    method: 'post',
    path: '/api/studio/internal/organisations/{id}/purge',
    summary: 'Purge an organisation Core deleted',
    description: `No body. Wipes every token and disconnects every channel, engages the organisation’s kill switch, cancels scheduled posts and soft-deletes Studio data with a ${PURGE_GRACE_DAYS}-day grace period. Idempotent: a repeat call re-applies the purge (catching anything created since), keeps the first graceUntil and answers repeated: true.`,
    pathParams: [idParam('PostMind organisation id (trimmed).', organisationIdParam)],
    responses: {
      '202': { description: 'Purge applied.', schema: purgeResponseSchema },
      '400': err('Invalid organisation id.'),
    },
  },
  {
    operationId: 'purgeBusiness',
    method: 'post',
    path: '/api/studio/internal/businesses/{id}/purge',
    summary: 'Purge a business Core deleted (business.deleted)',
    description: `BACKLOG 15.E2, spec 7.14 / 16.2, A11.7. Body { organisationId }. In one transaction: the business’s projects are soft-deleted and stopped (project kill switch), its scheduled posts cancelled, its style memories wiped and its business-scoped platform tokens wiped. Everything else of the business is hard-deleted by the retention sweep after the ${PURGE_GRACE_DAYS}-day grace. Idempotent: a repeat call re-applies the purge, keeps the first graceUntil and answers repeated: true.`,
    pathParams: [idParam('PostMind business id (trimmed).', businessIdParam)],
    requestBody: businessPurgeInput,
    responses: {
      '202': { description: 'Purge applied.', schema: businessPurgeResponseSchema },
      '400': err('Invalid organisation or business id, or body failed validation.'),
      '413': err(`Body larger than ${INTERNAL_MAX_BODY_BYTES} bytes.`),
    },
  },
  {
    operationId: 'attributeConversation',
    method: 'post',
    path: '/api/studio/internal/publications/{id}/attribute-conversation',
    summary: 'Attribute an Engagement conversation to a Studio publication',
    description:
      'BACKLOG 15.E3, spec 8.8. Called by Engagement when a comment, DM or mention on a Studio-published video arrives. Idempotent per (publication, conversation): a repeat answers repeated: true; isLead is sticky (once a lead, always a lead). 404 when the publication does not belong to the named organisation.',
    pathParams: [idParam('Studio publication id.', publicationIdParam)],
    requestBody: attributeConversationInput,
    responses: {
      '200': { description: 'Attributed (or already).', schema: attributionResponseSchema },
      '400': err('Invalid publication id, or body failed validation.'),
      '404': err('No such publication for this organisation (or the internal API is disabled).'),
      '413': err(`Body larger than ${INTERNAL_MAX_BODY_BYTES} bytes.`),
    },
  },
  {
    operationId: 'createProjectFromContent',
    method: 'post',
    path: '/api/studio/internal/projects/from-content',
    summary: 'Make a DRAFT video project from a PostMind post (“make a video from this post”)',
    description:
      'BACKLOG 15.W1, spec 8.8. Studio fetches the content from Core (GET /api/internal/content/:id) and creates a DRAFT project (sourceType POSTMIND_CONTENT, sourceRef = contentId) the user reviews and generates in Studio. businessId falls back to the content’s own business. UNTIL CORE PUBLISHES ITS CONTENT API this endpoint answers 501 not_implemented and creates nothing — Core must not wire it before then.',
    requestBody: fromContentInput,
    responses: {
      '201': { description: 'DRAFT project created.', schema: fromContentResponseSchema },
      '400': err('Body failed validation, no businessId, or the content has no text.'),
      '404': err('Content not found for this organisation (or the internal API is disabled).'),
      '413': err(`Body larger than ${INTERNAL_MAX_BODY_BYTES} bytes.`),
      '501': err('Waiting for Core’s content API: nothing was created (error: not_implemented).'),
    },
  },
];

type JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
  }) as JsonSchema;
  return rest;
}

function queryParameters(query: z.ZodObject) {
  const schema = jsonSchema(query, 'input') as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(schema.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: (schema.required ?? []).includes(name),
    schema: s,
  }));
}

function operationObject(op: InternalOperation) {
  const responses = { ...COMMON_ERRORS, ...op.responses };
  return {
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    tags: ['internal'],
    security: [{ serviceToken: [] }],
    parameters: [
      ...(op.pathParams ?? []).map((p) => ({
        name: p.name,
        in: 'path',
        required: true,
        description: p.description,
        schema: jsonSchema(p.schema, 'input'),
      })),
      ...(op.query ? queryParameters(op.query) : []),
      { $ref: '#/components/parameters/CorrelationId' },
    ],
    ...(op.requestBody && {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: jsonSchema(op.requestBody, 'input') } },
      },
    }),
    responses: Object.fromEntries(
      Object.entries(responses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, r]) => [
          status,
          {
            description: r.description,
            headers: {
              'x-correlation-id': { $ref: '#/components/headers/CorrelationId' },
              ...(status === '429' && {
                'Retry-After': { $ref: '#/components/headers/RetryAfter' },
              }),
            },
            content: { 'application/json': { schema: jsonSchema(r.schema, 'output') } },
          },
        ]),
    ),
  };
}

/** The OpenAPI 3.1 document for Studio's internal API (deterministic: same input, same JSON). */
export function buildInternalOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of INTERNAL_OPERATIONS) {
    paths[op.path] = { ...paths[op.path], [op.method]: operationObject(op) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'PostMind Studio internal API (for PostMind Core)',
      version: '1.0.0',
      description: [
        'Service-to-service endpoints PostMind Core calls, mirroring Engagement handover 14.13.',
        'Authenticate with the X-Service-Token header (STUDIO_INTERNAL_SERVICE_TOKEN on Studio,',
        `at least ${INTERNAL_TOKEN_MIN_LENGTH} characters). Route /api/studio/internal/* from the`,
        'private network only. Every operation is idempotent, so Core may retry it after a',
        'timeout, a 429 (honour Retry-After) or a 5xx. Bodies are capped at',
        `${INTERNAL_MAX_BODY_BYTES} bytes. Responses never contain access tokens.`,
        'GENERATED from the route handlers’ zod schemas — do not edit by hand.',
      ].join(' '),
    },
    servers: [
      { url: 'https://{studioHost}', variables: { studioHost: { default: 'studio.internal' } } },
    ],
    tags: [{ name: 'internal', description: 'Called by PostMind Core only.' }],
    paths,
    components: {
      securitySchemes: {
        serviceToken: { type: 'apiKey', in: 'header', name: 'X-Service-Token' },
      },
      parameters: {
        CorrelationId: {
          name: 'x-correlation-id',
          in: 'header',
          required: false,
          description:
            'Optional request id (letters, digits, . _ -; up to 128). Studio logs under it and echoes it; any other value is replaced by a generated one. Send the same value on every retry of one logical call.',
          schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
        },
      },
      headers: {
        CorrelationId: {
          description: 'The request id Studio logged this request under.',
          schema: { type: 'string' },
        },
        RetryAfter: {
          description: 'Seconds to wait before retrying.',
          schema: { type: 'integer', minimum: 0 },
        },
      },
    },
  };
}

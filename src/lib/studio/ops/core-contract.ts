import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  StudioInternalClient,
  StudioInternalError,
  type RegisterChannelInput,
} from '../../../../integrations/core/client/studio-internal-client';
import {
  disconnectResponseSchema,
  errorResponseSchema,
  purgeResponseSchema,
  refreshBatchResponseSchema,
  refreshSingleResponseSchema,
  registerResponseSchema,
} from '../api/internal-contract';
import { INTERNAL_MAX_BODY_BYTES } from '../api/internal';
import { ValidationError } from '../../errors';

// BACKLOG 14.10 — the contract suite PostMind Core runs against Studio staging before (and
// after) wiring the internal endpoints:
//   npm run contract:core -- --base-url https://studio-staging.internal --token <service token>
// It drives the copyable client (integrations/core/client) through every internal operation
// with a synthetic organisation (contract-core-<time>-<random>) and a fake token, and checks
// status codes, the response shapes in integrations/core/openapi.json, idempotency, and that no
// token is ever echoed. It ends by purging the synthetic organisation, so it leaves only
// soft-deleted rows with wiped tokens behind. Never point it at production.

export interface ContractCheck {
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface ContractReport {
  baseUrl: string;
  organisationId: string;
  checks: ContractCheck[];
  passed: boolean;
}

export interface ContractOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test hook: the retry sleep (default real time). */
  sleep?: (ms: number) => Promise<void>;
}

/** A failed expectation inside the suite (reported, never thrown out of runCoreContract). */
class ContractFailure extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractFailure(message);
}

function conforms<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ContractFailure(
      `${what} does not match integrations/core/openapi.json: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

const fakeToken = () => `CONTRACT${randomBytes(24).toString('hex')}`;
const graphId = () => `9${Date.now()}${randomBytes(3).readUIntBE(0, 3)}`;

export async function runCoreContract(options: ContractOptions): Promise<ContractReport> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const client = new StudioInternalClient({
    baseUrl,
    serviceToken: options.token,
    fetch: doFetch,
    maxAttempts: 3,
    ...(options.sleep && { sleep: options.sleep }),
  });
  const organisationId = `contract-core-${now()}-${randomBytes(3).toString('hex')}`;
  const checks: ContractCheck[] = [];
  const seenTokens: string[] = [];

  const raw = async (method: string, path: string, body?: string, token = options.token) => {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: { 'x-service-token': token, 'content-type': 'application/json' },
      body,
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      json = { nonJson: text.slice(0, 200) };
    }
    return { status: res.status, text, json };
  };
  const noTokenIn = (text: string, what: string) => {
    for (const t of seenTokens) expect(!text.includes(t), `${what} echoed an access token`);
  };
  const check = async (name: string, run: () => Promise<void>) => {
    const started = now();
    try {
      await run();
      checks.push({ name, ok: true, ms: now() - started });
    } catch (err) {
      const detail =
        err instanceof ContractFailure || err instanceof StudioInternalError
          ? err.message
          : `unexpected: ${err instanceof Error ? err.message : String(err)}`;
      checks.push({ name, ok: false, detail, ms: now() - started });
    }
  };

  const account = { organisationId, platform: 'instagram' as const, platformAccountId: graphId() };
  const registration = (): RegisterChannelInput => {
    const accessToken = fakeToken();
    seenTokens.push(accessToken);
    return {
      ...account,
      platformAccountName: '@contract.test',
      accessToken,
      tokenExpiresAt: new Date(now() + 60 * 86_400_000).toISOString(),
      scopes: ['instagram_basic', 'instagram_content_publish'],
    };
  };
  let channelId = '';

  await check('rejects a wrong X-Service-Token with 401', async () => {
    const res = await raw('POST', '/api/studio/internal/channels', '{}', `wrong-${fakeToken()}`);
    expect(
      res.status !== 404,
      '404: the internal API is disabled (STUDIO_INTERNAL_SERVICE_TOKEN unset) or not routed to Studio',
    );
    expect(res.status === 401, `expected 401, got ${res.status}`);
    conforms(errorResponseSchema, res.json, '401 body');
  });

  await check('rejects an invalid body with 400 and never echoes values', async () => {
    const leaked = fakeToken();
    const res = await raw(
      'POST',
      '/api/studio/internal/channels',
      JSON.stringify({ organisationId, platform: 'myspace', accessToken: `${leaked} x` }),
    );
    expect(res.status !== 401, 'the service token was refused (401): check --token');
    expect(res.status === 400, `expected 400, got ${res.status}`);
    const body = conforms(errorResponseSchema, res.json, '400 body');
    expect(body.error === 'validation_error', `expected validation_error, got ${body.error}`);
    expect((body.details?.issues?.length ?? 0) > 0, 'expected details.issues');
    expect(!res.text.includes(leaked), '400 body echoed the submitted token');
  });

  await check(`rejects a body over ${INTERNAL_MAX_BODY_BYTES} bytes with 413`, async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(INTERNAL_MAX_BODY_BYTES + 1) });
    const res = await raw('POST', '/api/studio/internal/tokens/refreshed', big);
    expect(res.status === 413, `expected 413, got ${res.status}`);
  });

  await check('registerChannel creates (201) a channel without returning the token', async () => {
    const input = registration();
    const res = await raw('POST', '/api/studio/internal/channels', JSON.stringify(input));
    expect(res.status === 201, `expected 201, got ${res.status}: ${res.text.slice(0, 200)}`);
    const body = conforms(registerResponseSchema, res.json, 'registerChannel 201 body');
    expect(body.created, 'created should be true');
    expect(body.channel.state === 'active', `state ${body.channel.state}`);
    noTokenIn(res.text, 'registerChannel');
    channelId = body.channel.id;
  });

  await check('registerChannel is idempotent (200, same id, created: false)', async () => {
    const res = await client.registerChannel(registration());
    conforms(registerResponseSchema, { ok: true, ...res }, 'registerChannel 200 body');
    expect(!res.created, 'created should be false on re-registration');
    expect(res.channel.id === channelId, 're-registration returned a different id');
  });

  await check('pushRefreshedToken updates a registered channel', async () => {
    const accessToken = fakeToken();
    seenTokens.push(accessToken);
    const res = await client.pushRefreshedToken({ ...account, accessToken });
    const body = conforms(refreshSingleResponseSchema, { ok: true, ...res }, 'refresh body');
    expect(body.result.result === 'updated', `result ${body.result.result}`);
  });

  await check('pushRefreshedTokens reports per-channel results (updated, not_found)', async () => {
    const results = await client.pushRefreshedTokens([
      { ...account, accessToken: fakeToken() },
      { ...account, platformAccountId: graphId(), accessToken: fakeToken() },
    ]);
    conforms(refreshBatchResponseSchema, { ok: true, results }, 'batch refresh body');
    expect(
      results.map((r) => r.result).join(',') === 'updated,not_found',
      `results ${results.map((r) => r.result).join(',')}`,
    );
  });

  await check('pushRefreshedToken for an unregistered channel is 404', async () => {
    try {
      await client.pushRefreshedToken({
        ...account,
        platformAccountId: graphId(),
        accessToken: fakeToken(),
      });
      throw new ContractFailure('expected 404');
    } catch (err) {
      expect(err instanceof StudioInternalError && err.status === 404, `got ${String(err)}`);
    }
  });

  await check('disconnectChannelByAccount revokes the channel', async () => {
    const res = await client.disconnectChannelByAccount(account);
    const body = conforms(disconnectResponseSchema, { ok: true, ...res }, 'disconnect body');
    expect(body.channel.state === 'revoked', `state ${body.channel.state}`);
    expect(body.channel.accessTokenExpiresAt === null, 'token expiry should be cleared');
  });

  await check('pushRefreshedToken after a disconnect is 409 (register to reconnect)', async () => {
    try {
      await client.pushRefreshedToken({ ...account, accessToken: fakeToken() });
      throw new ContractFailure('expected 409');
    } catch (err) {
      expect(err instanceof StudioInternalError && err.status === 409, `got ${String(err)}`);
    }
  });

  await check('disconnectChannel by id is idempotent (200 on a revoked channel)', async () => {
    expect(channelId, 'no channel id (registration failed)');
    const res = await client.disconnectChannel(channelId, { organisationId });
    conforms(disconnectResponseSchema, { ok: true, ...res }, 'disconnect-by-id body');
  });

  await check('purgeOrganisation answers 202 and is idempotent', async () => {
    const first = await client.purgeOrganisation(organisationId);
    conforms(purgeResponseSchema, { ok: true, ...first }, 'purge body');
    expect(first.purge.organisationId === organisationId, 'purge for a different organisation');
    const second = await client.purgeOrganisation(organisationId);
    expect(second.purge.repeated, 'a repeat purge should report repeated: true');
    expect(second.purge.graceUntil === first.purge.graceUntil, 'graceUntil changed on repeat');
  });

  return { baseUrl, organisationId, checks, passed: checks.every((c) => c.ok) };
}

/** Plain-text report for the CLI. */
export function formatContractReport(report: ContractReport): string {
  const lines = [
    `Studio internal API contract — ${report.baseUrl}`,
    `synthetic organisation: ${report.organisationId}`,
    '',
    ...report.checks.map(
      (c) =>
        `${c.ok ? 'PASS' : 'FAIL'}  ${c.name} (${c.ms} ms)${c.detail ? `\n      ${c.detail}` : ''}`,
    ),
    '',
    `${report.checks.filter((c) => c.ok).length}/${report.checks.length} passed`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Parse `--base-url <url> --token <token>` (also --flag=value); the token may come from env. */
export function parseContractArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; token: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === '--base-url' || flag === '--token') values[flag] = inline ?? argv[++i] ?? '';
  }
  const baseUrl = values['--base-url'] ?? env.STUDIO_CONTRACT_BASE_URL ?? '';
  const token = values['--token'] ?? env.STUDIO_CONTRACT_TOKEN ?? '';
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl))
    throw new ValidationError('--base-url must be an http(s) URL of Studio staging');
  if (token.length < 32)
    throw new ValidationError(
      '--token must be the staging STUDIO_INTERNAL_SERVICE_TOKEN (≥ 32 chars)',
    );
  return { baseUrl, token };
}

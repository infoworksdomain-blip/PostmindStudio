import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildInternalOpenApi,
  INTERNAL_OPERATIONS,
} from '../../src/lib/studio/api/internal-contract';
import {
  accountRefInput,
  refreshedTokensInput,
  registerMetaChannelInput,
} from '../../src/lib/studio/services/meta-channels';

// BACKLOG 14.10 — the committed OpenAPI spec for Core (integrations/core/openapi.json) must match
// what the internal route handlers actually validate. Fails when:
//   - a zod schema changed and the spec was not regenerated
//     (fix: npx tsx scripts/core/generate-openapi.ts);
//   - an internal route or method was added / removed without a contract entry;
//   - a route stopped validating with the schema its contract entry declares.

const ROOT = resolve(__dirname, '../..');
const INTERNAL_DIR = join(ROOT, 'src/app/api/studio/internal');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

function routeOperations() {
  return routeFiles(INTERNAL_DIR).flatMap((file) => {
    const dir = relative(join(ROOT, 'src/app'), file).split(sep).slice(0, -1);
    const path = `/${dir.map((seg) => seg.replace(/^\[(.+)\]$/, '{$1}')).join('/')}`;
    const source = readFileSync(file, 'utf8');
    return METHODS.filter((m) => new RegExp(`export const ${m}\\b`).test(source)).map((m) => ({
      key: `${m.toLowerCase()} ${path}`,
      source,
    }));
  });
}

describe('integrations/core/openapi.json', () => {
  it('is exactly what the internal routes’ zod schemas generate', () => {
    const committed: unknown = JSON.parse(
      readFileSync(join(ROOT, 'integrations/core/openapi.json'), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildInternalOpenApi())));
  });

  it('documents every internal route and method, and nothing else', () => {
    const routes = routeOperations()
      .map((r) => r.key)
      .sort();
    const documented = INTERNAL_OPERATIONS.map((op) => `${op.method} ${op.path}`).sort();
    expect(documented).toEqual(routes);
  });

  it('each route validates with the schema its contract entry declares', () => {
    const byKey = new Map(routeOperations().map((r) => [r.key, r.source]));
    const expectations: Array<[string, z.ZodType, string]> = [
      ['post /api/studio/internal/channels', registerMetaChannelInput, 'registerMetaChannelInput'],
      ['delete /api/studio/internal/channels', accountRefInput, 'accountRefInput'],
      ['post /api/studio/internal/tokens/refreshed', refreshedTokensInput, 'refreshedTokensInput'],
    ];
    for (const [key, schema, name] of expectations) {
      expect(byKey.get(key), key).toContain(name);
      const op = INTERNAL_OPERATIONS.find((o) => `${o.method} ${o.path}` === key);
      expect(op?.requestBody ?? op?.query).toBe(schema);
    }
  });

  it('is an OpenAPI 3.1 document with the service-token scheme on every operation', () => {
    const spec = buildInternalOpenApi();
    expect(spec.openapi).toBe('3.1.0');
    const operations = Object.values(spec.paths).flatMap((p) => Object.values(p)) as Array<{
      security: unknown;
      responses: Record<string, unknown>;
      operationId: string;
    }>;
    expect(operations).toHaveLength(INTERNAL_OPERATIONS.length);
    for (const op of operations) {
      expect(op.security).toEqual([{ serviceToken: [] }]);
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['401', '429', '500']));
    }
    expect(new Set(operations.map((o) => o.operationId)).size).toBe(operations.length);
  });

  it('request schemas in the spec accept and refuse what the handlers do', () => {
    const spec = buildInternalOpenApi() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          { requestBody?: { content: Record<string, { schema: { required?: string[] } }> } }
        >
      >;
    };
    const register = spec.paths['/api/studio/internal/channels']?.post?.requestBody;
    expect(register?.content['application/json']?.schema.required).toEqual(
      expect.arrayContaining(['organisationId', 'platform', 'platformAccountId', 'accessToken']),
    );
    expect(register?.content['application/json']?.schema.required).not.toContain('scopes');
  });
});

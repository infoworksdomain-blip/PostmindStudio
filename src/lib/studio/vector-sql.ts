import { Prisma } from '@prisma/client';
import { ConfigurationError } from '../errors';

// pgvector lives wherever the extension was installed: in `studio` when Studio's first migration
// installed it, or in another schema (typically `public`) when PostMind Core installed it first on
// the shared cluster. Prisma pins search_path to `studio`, so an unqualified `vector` type or `<=>`
// operator only resolves in the first case. Every raw vector query therefore qualifies the type
// and operator with the extension's actual schema (looked up once per client and cached).

/** The subset of a Prisma client this needs (tests pass a stub). */
export interface RawQueryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T>;
}

export interface VectorSql {
  /** Append to a value: `${literal}${v.cast}` → `'[...]'::"schema".vector`. */
  cast: Prisma.Sql;
  /** Cosine distance: `a ${v.distance} b` → `a OPERATOR("schema".<=>) b`. */
  distance: Prisma.Sql;
  schema: string;
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const cache = new WeakMap<object, Promise<string>>();

export function vectorSqlFor(schema: string): VectorSql {
  // The name is interpolated into SQL, so only plain identifiers are accepted.
  if (!SCHEMA_NAME.test(schema)) {
    throw new ConfigurationError(`Unexpected pgvector schema name: ${schema}`);
  }
  return {
    schema,
    cast: Prisma.raw(`::"${schema}".vector`),
    distance: Prisma.raw(`OPERATOR("${schema}".<=>)`),
  };
}

async function lookupSchema(db: RawQueryClient): Promise<string> {
  const rows = await db.$queryRaw<Array<{ schema: string }>>`
    SELECT n.nspname AS schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'vector'`;
  const schema = rows[0]?.schema;
  if (!schema) throw new ConfigurationError('The pgvector extension is not installed');
  return schema;
}

export async function vectorSql(db: RawQueryClient): Promise<VectorSql> {
  let pending = cache.get(db);
  if (!pending) {
    pending = lookupSchema(db);
    cache.set(db, pending);
    // A failed lookup (DB down) must not be cached forever.
    pending.catch(() => cache.delete(db));
  }
  return vectorSqlFor(await pending);
}

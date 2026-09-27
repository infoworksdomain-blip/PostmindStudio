import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vectorSql, type RawQueryClient } from '../../src/lib/studio/vector-sql';
import { createMigratedDb } from './helpers/migrated-db';

// Operator: unknown whether PostMind Core already installed pgvector on the shared cluster, so
// Studio must work whether the extension lives in "studio" (Studio installed it) or "public".

const dims = (n: number) =>
  `[${Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0)).join(',')}]`;

function rawClient(pg: PGlite): RawQueryClient {
  return {
    async $queryRaw<T>(query: TemplateStringsArray | { strings?: readonly string[] }) {
      const text = Array.isArray(query) ? (query as readonly string[]).join('') : '';
      return (await pg.query(text)).rows as T;
    },
  };
}

describe.each([
  { where: 'studio', preinstall: undefined },
  { where: 'public', preinstall: 'public' as const },
])('pgvector installed in $where', ({ where, preinstall }) => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createMigratedDb({ preinstallVectorIn: preinstall });
  }, 60_000);
  afterAll(async () => pg?.close());

  it('applies every migration and creates the embedding columns as vector(1536)', async () => {
    const { rows } = await pg.query<{ table_name: string; type: string }>(
      `SELECT c.relname AS table_name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'studio' AND a.attname = 'embedding' ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['image_library', 'video_library_embeddings']);
    for (const r of rows) expect(r.type).toMatch(/vector\(1536\)$/);
  });

  it('locates the extension and runs qualified similarity queries', async () => {
    const v = await vectorSql(rawClient(pg));
    expect(v.schema).toBe(where);
    const cast = `::"${v.schema}".vector`;
    const op = `OPERATOR("${v.schema}".<=>)`;
    await pg.query(
      `INSERT INTO studio.image_library
         (id, "organisationId", "businessId", source, "s3Bucket", "s3Key", "widthPx", "heightPx",
          "fileSizeBytes", tags, fingerprint, embedding)
       VALUES ('a', 'o', 'b', 'STOCK', 'x', 'a', 1, 1, 1, '{}', 'fa', '${dims(0)}'${cast}),
              ('b', 'o', 'b', 'STOCK', 'x', 'b', 1, 1, 1, '{}', 'fb', '${dims(1)}'${cast})`,
    );
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM studio.image_library ORDER BY embedding ${op} '${dims(1)}'${cast} LIMIT 1`,
    );
    expect(rows[0]?.id).toBe('b');
  });

  if (where === 'public') {
    it('proves the problem is real: an unqualified ::vector does not resolve', async () => {
      await expect(pg.query(`SELECT '${dims(0)}'::vector`)).rejects.toThrow(/vector/);
    });
  }
});

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KillSwitchTriggeredError } from '../../src/lib/errors';
import { createKillSwitch, type FlagStore } from '../../src/lib/studio/kill-switch';
import { defaultSystemFlags, flagKeys } from '../../src/lib/studio/system-flags';
import { createMigratedDb } from './helpers/migrated-db';

// Kill switch against real studio.system_flags rows (BACKLOG 1.9 + 1.10).

let db: PGlite;

function sqlFlagStore(): FlagStore {
  return {
    async getFlags(keys) {
      const { rows } = await db.query<{ key: string; value: string }>(
        'SELECT key, value FROM studio.system_flags WHERE key = ANY($1::text[])',
        [[...keys]],
      );
      return new Map(rows.map((r) => [r.key, r.value]));
    },
  };
}

// Same semantics as seedSystemFlags (createMany + skipDuplicates) expressed in SQL.
async function seed(): Promise<void> {
  for (const flag of defaultSystemFlags()) {
    await db.query(
      `INSERT INTO studio.system_flags (key, value, "updatedAt") VALUES ($1, $2, now())
       ON CONFLICT (key) DO NOTHING`,
      [flag.key, flag.value],
    );
  }
}

async function setFlag(key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO studio.system_flags (key, value, "updatedAt") VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
    [key, value],
  );
}

beforeAll(async () => {
  db = await createMigratedDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('DELETE FROM studio.system_flags');
  await seed();
});

const scope = { organisationId: 'org-1', projectId: 'proj-1', providerId: 'runway' };

describe('kill switch on studio.system_flags', () => {
  it('lets work through on a freshly seeded database', async () => {
    await expect(createKillSwitch({ store: sqlFlagStore() }).check(scope)).resolves.toEqual({
      killed: false,
    });
  });

  it.each([
    ['global', flagKeys.global()],
    ['workspace', flagKeys.workspace('org-1')],
    ['project', flagKeys.project('proj-1')],
    ['provider', flagKeys.provider('runway')],
  ] as const)('stops work at the %s level', async (level, key) => {
    await setFlag(key, 'true');
    await expect(
      createKillSwitch({ store: sqlFlagStore() }).assertNotKilled(scope),
    ).rejects.toMatchObject({ level });
  });

  it('re-seeding never switches an active kill switch back off', async () => {
    await setFlag(flagKeys.global(), 'true');
    await seed();
    const { rows } = await db.query<{ value: string }>(
      'SELECT value FROM studio.system_flags WHERE key = $1',
      [flagKeys.global()],
    );
    expect(rows[0]?.value).toBe('true');
  });

  it('takes effect in another process within the 30s cache window', async () => {
    let now = 0;
    const worker = createKillSwitch({ store: sqlFlagStore(), now: () => now });
    await worker.assertNotKilled(scope);

    await setFlag(flagKeys.global(), 'true'); // toggled by an operator elsewhere
    now = 30_000;
    await expect(worker.assertNotKilled(scope)).rejects.toBeInstanceOf(KillSwitchTriggeredError);

    await setFlag(flagKeys.global(), 'false'); // un-toggled
    now = 60_000;
    await expect(worker.assertNotKilled(scope)).resolves.toBeUndefined();
  });
});

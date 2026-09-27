import type { PrismaClient } from '@prisma/client';

// BACKLOG 13.25 — the Hive adapter's poll() source for async tasks: the callback body stored by
// POST /api/studio/webhooks/hive (pipeline/content-safety-async.ts recordHiveCallback), looked up
// by Hive task id. null until the callback has arrived.

export function createHiveResultReader(db: () => Promise<Pick<PrismaClient, 'contentSafetyTask'>>) {
  return async (hiveTaskId: string): Promise<unknown> => {
    const client = await db();
    const task = await client.contentSafetyTask.findFirst({
      where: { providerTaskId: hiveTaskId, state: { in: ['CALLBACK_RECEIVED', 'SETTLED'] } },
      select: { result: true },
    });
    return task?.result ?? null;
  };
}

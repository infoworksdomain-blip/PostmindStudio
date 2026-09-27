import { describe, expect, it, vi } from 'vitest';
import { createHiveResultReader } from './hive-results';

describe('createHiveResultReader', () => {
  it('returns the stored callback body for a received task, else null', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ result: { id: 'task-1' } })
      .mockResolvedValueOnce(null);
    const read = createHiveResultReader(
      async () => ({ contentSafetyTask: { findFirst } }) as never,
    );
    expect(await read('task-1')).toEqual({ id: 'task-1' });
    expect(await read('task-2')).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { providerTaskId: 'task-1', state: { in: ['CALLBACK_RECEIVED', 'SETTLED'] } },
      select: { result: true },
    });
  });
});

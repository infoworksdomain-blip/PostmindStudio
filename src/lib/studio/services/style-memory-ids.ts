import { z } from 'zod';
import { ValidationError } from '../../errors';

const memoryIdParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Style-memory row id from the URL (cuid). */
export function parseStyleMemoryId(value: unknown): string {
  const parsed = memoryIdParam.safeParse(value);
  if (!parsed.success) throw new ValidationError('memoryId is invalid');
  return parsed.data;
}

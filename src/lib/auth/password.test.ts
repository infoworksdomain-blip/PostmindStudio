import { describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS, createArgon2Hasher, MAX_CONCURRENT_HASHES, Semaphore } from './password';

describe('argon2id hasher (Phase 18 §5.1)', () => {
  it('hashes with the OWASP parameters and verifies', async () => {
    const hasher = createArgon2Hasher();
    const encoded = await hasher.hash('correct horse battery staple');
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(
      hasher.verify({ hash: encoded, password: 'correct horse battery staple' }),
    ).resolves.toBe(true);
    await expect(hasher.verify({ hash: encoded, password: 'wrong' })).resolves.toBe(false);
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('treats a malformed stored hash as a failed verification, not an error', async () => {
    await expect(createArgon2Hasher().verify({ hash: 'not-a-hash', password: 'x' })).resolves.toBe(
      false,
    );
  });

  it('never runs more than MAX_CONCURRENT_HASHES (4) at once on the 2 GB server (§8)', async () => {
    expect(MAX_CONCURRENT_HASHES).toBe(4);
    const slots = new Semaphore(MAX_CONCURRENT_HASHES);
    let running = 0;
    let peak = 0;
    const task = () =>
      slots.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return 'done';
      });
    const results = await Promise.all(Array.from({ length: 12 }, task));
    expect(results.every((r) => r === 'done')).toBe(true);
    expect(peak).toBe(4);
    expect(slots.inUse).toBe(0);
    expect(slots.queued).toBe(0);
  });

  it('releases the slot when a task throws, and serves waiters in order', async () => {
    const slots = new Semaphore(1);
    const order: number[] = [];
    const first = slots.run(async () => {
      throw new Error('boom');
    });
    const second = slots.run(async () => order.push(2));
    const third = slots.run(async () => order.push(3));
    await expect(first).rejects.toThrow('boom');
    await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
    expect(slots.inUse).toBe(0);
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});

import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';

// Phase 18 §5.1 — password hashing: argon2id with the OWASP Password Storage Cheat Sheet's first
// recommended configuration (m=19456 KiB, t=2, p=1;
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html, read
// 2026-09-29). Better Auth's default is scrypt; its emailAndPassword.password.{hash, verify} hooks
// take ours (https://www.better-auth.com/docs/authentication/email-password#configuration, read
// 2026-09-29). @node-rs/argon2 2.2.1 runs the work on libuv's thread pool.
//
// Memory budget (§8, 2 GB VPS): each hash holds ~19 MiB, so at most MAX_CONCURRENT_HASHES run at
// once and the rest wait in FIFO order. Better Auth hashes a dummy password for unknown emails on
// sign-in, so every sign-in attempt costs one slot: the auth rate limits bound the queue.

export const ARGON2_OPTIONS: Readonly<Options> = Object.freeze({
  // Algorithm.Argon2id (= 2): the package's enum is a `const enum`, not importable under
  // isolatedModules.
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

export const MAX_CONCURRENT_HASHES = 4;

/** FIFO counting semaphore. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be ≥ 1');
  }

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter (active stays the same) or release it.
      if (next) next();
      else this.active -= 1;
    }
  }
}

const hashSlots = new Semaphore(MAX_CONCURRENT_HASHES);

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(data: { hash: string; password: string }): Promise<boolean>;
}

export function createArgon2Hasher(
  slots: Semaphore = hashSlots,
  options: Readonly<Options> = ARGON2_OPTIONS,
): PasswordHasher {
  return {
    hash: (password) => slots.run(() => hash(password, options)),
    verify: ({ hash: encoded, password }) =>
      slots.run(async () => {
        // A malformed stored hash is a failed verification, never a 500 that leaks which branch
        // an account took.
        try {
          return await verify(encoded, password);
        } catch {
          return false;
        }
      }),
  };
}

/** Phase 18 §5.1: 12–128 characters. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

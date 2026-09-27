import { randomUUID } from 'node:crypto';
import type { ProviderPollResult } from './interface';

// Synchronous providers (Anthropic, OpenAI, ElevenLabs) do their work inside submit(). The
// result is parked here so poll() can return it, keeping one submit→poll contract for the
// router and workers. Results live in process memory: the worker that submits also polls in
// the same job. If the process restarts in between, poll() reports a retryable
// 'result_expired' failure and the job re-submits. Nothing is faked.

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class SyncJobStore {
  private readonly results = new Map<string, { result: ProviderPollResult; expiresAt: number }>();

  constructor(
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  put(result: ProviderPollResult): string {
    this.evictExpired();
    const id = `${this.prefix}_${randomUUID()}`;
    this.results.set(id, { result, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  get(id: string): ProviderPollResult {
    const entry = this.results.get(id);
    if (!entry || entry.expiresAt <= this.now()) {
      this.results.delete(id);
      return {
        state: 'failed',
        error: {
          class: 'result_expired',
          message: 'Synchronous result is no longer held by this process; re-submit',
          retryable: true,
        },
      };
    }
    return entry.result;
  }

  delete(id: string): void {
    this.results.delete(id);
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.results) {
      if (entry.expiresAt <= now) this.results.delete(id);
    }
  }
}

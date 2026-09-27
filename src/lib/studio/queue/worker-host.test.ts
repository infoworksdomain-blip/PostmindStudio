import { describe, expect, it } from 'vitest';
import { QUEUES } from './queues';
import { concurrencyFor, DEFAULT_CONCURRENCY, MAX_LIBRARY_CONCURRENCY } from './worker-host';

// Corpus ingestion throughput (runbooks/corpus-ingestion.md): STUDIO_LIBRARY_CONCURRENCY.

describe('library queue concurrency', () => {
  it('defaults to 2', () => {
    expect(concurrencyFor(QUEUES.library, {})).toBe(2);
    expect(DEFAULT_CONCURRENCY[QUEUES.library]).toBe(2);
  });

  it('reads STUDIO_LIBRARY_CONCURRENCY, which wins over WORKER_CONCURRENCY_LIBRARY', () => {
    expect(concurrencyFor(QUEUES.library, { STUDIO_LIBRARY_CONCURRENCY: '6' })).toBe(6);
    expect(
      concurrencyFor(QUEUES.library, {
        STUDIO_LIBRARY_CONCURRENCY: '6',
        WORKER_CONCURRENCY_LIBRARY: '3',
      }),
    ).toBe(6);
    expect(concurrencyFor(QUEUES.library, { WORKER_CONCURRENCY_LIBRARY: '3' })).toBe(3);
  });

  it('ignores invalid values and caps at the memory-safe maximum', () => {
    expect(concurrencyFor(QUEUES.library, { STUDIO_LIBRARY_CONCURRENCY: 'x' })).toBe(2);
    expect(concurrencyFor(QUEUES.library, { STUDIO_LIBRARY_CONCURRENCY: '0' })).toBe(2);
    expect(concurrencyFor(QUEUES.library, { STUDIO_LIBRARY_CONCURRENCY: '1.5' })).toBe(2);
    expect(concurrencyFor(QUEUES.library, { STUDIO_LIBRARY_CONCURRENCY: '500' })).toBe(
      MAX_LIBRARY_CONCURRENCY,
    );
  });

  it('does not affect other queues', () => {
    expect(concurrencyFor(QUEUES.assets, { STUDIO_LIBRARY_CONCURRENCY: '9' })).toBe(15);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import '../../demo/api/handlers/index';
import { handle } from '../../demo/api/registry';

// The demo's reference-library search has the same relevance floor as live: a query with no real
// match returns nothing (the screen then says "No close matches"), not bakery videos at 42%.

async function search(q: string) {
  const res = await handle(new URL('https://studio.demo/api/studio/library/search'), {
    method: 'POST',
    body: JSON.stringify({ q, limit: 24 }),
  });
  return (await res.json()) as { data: Array<{ title: string; similarity: number }> };
}

describe('demo: library search relevance', { timeout: 30_000 }, () => {
  it('finds the luxury car videos for "luxury cars"', async () => {
    const { data } = await search('luxury cars');
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data[0]?.title).toMatch(/luxury car/i);
    expect(data.some((v) => /crust|café fit-out/i.test(v.title))).toBe(false);
  });

  it('returns nothing for a query that matches no video', async () => {
    expect((await search('submarine tax law')).data).toEqual([]);
  });

  it('still finds a bakery video for a bakery query', async () => {
    expect((await search('sourdough bakery')).data.length).toBeGreaterThan(0);
  });

  it('finds a workout video for "gym workout"', async () => {
    expect((await search('gym workout')).data[0]?.title).toMatch(/gym/i);
  });
});

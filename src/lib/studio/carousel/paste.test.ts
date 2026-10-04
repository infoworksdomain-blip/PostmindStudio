import { describe, expect, it } from 'vitest';
import { parsePastedThread } from './paste';

describe('parsePastedThread', () => {
  it('splits on --- divider lines', () => {
    expect(parsePastedThread('Hook\n---\nBody\nmore\n---\nCTA', 12)).toEqual([
      'Hook',
      'Body\nmore',
      'CTA',
    ]);
  });

  it('splits numbered posts (1/, 2/7, 3.) and drops the numbers', () => {
    expect(parsePastedThread('1/ Hook line\n2/7 Second\nstill second\n3. Third', 12)).toEqual([
      'Hook line',
      'Second\nstill second',
      'Third',
    ]);
  });

  it('does not split a list that does not count from 1', () => {
    expect(parsePastedThread('Intro\n\n3. three\n4. four', 12)).toEqual([
      'Intro',
      '3. three\n4. four',
    ]);
  });

  it('uses double blank lines when present, else paragraphs', () => {
    expect(parsePastedThread('A\n\nstill A\n\n\nB', 12)).toEqual(['A\n\nstill A', 'B']);
    expect(parsePastedThread('A\n\nB\n\nC', 12)).toEqual(['A', 'B', 'C']);
  });

  it('caps the number of posts and their length', () => {
    const posts = parsePastedThread(Array.from({ length: 20 }, (_, i) => `P${i}`).join('\n\n'), 12);
    expect(posts).toHaveLength(12);
    expect(parsePastedThread('x'.repeat(900), 12)[0]).toHaveLength(600);
    expect(parsePastedThread('   ', 12)).toEqual([]);
  });
});

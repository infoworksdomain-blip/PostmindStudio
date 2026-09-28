import { describe, expect, it } from 'vitest';
import { findPhysicalClasses } from './physical-css';

describe('findPhysicalClasses', () => {
  it('flags physical spacing, position, alignment, border and radius classes', () => {
    const src = `<div className="ml-2 md:pr-4 -right-0.5 text-left border-r rounded-l-md" />`;
    expect(findPhysicalClasses(src).map((h) => [h.token, h.suggestion])).toEqual([
      ['ml-2', 'ms-2'],
      ['pr-4', 'pe-4'],
      ['-right-0.5', '-end-0.5'],
      ['text-left', 'text-start'],
      ['border-r', 'border-e'],
      ['rounded-l-md', 'rounded-s-md'],
    ]);
  });

  it('reports line and column', () => {
    const [hit] = findPhysicalClasses(`const a = 1;\n  cn('flex', 'pl-3')`);
    expect(hit).toMatchObject({ line: 2, column: 15, token: 'pl-3' });
  });

  it('ignores logical classes and words that merely contain left/right', () => {
    const src = `<p className="ms-2 pe-4 start-0 text-start border-e" aria-label="Move left">right now</p>`;
    expect(findPhysicalClasses(src)).toEqual([]);
    expect(findPhysicalClasses(`const copyright = 'x'; html-left-x left-to-right`)).toEqual([]);
  });
});

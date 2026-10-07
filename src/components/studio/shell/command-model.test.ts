import { describe, expect, it } from 'vitest';
import { filterCommands, moveActive, normalise, type CommandEntry } from './command-model';

const entries: CommandEntry[] = [
  { id: 'a', group: 'navigate', label: 'Calendar', keywords: 'Plan', href: '/calendar' },
  { id: 'b', group: 'navigate', label: 'Month plans', keywords: 'Plan', href: '/plans' },
  { id: 'c', group: 'business', label: 'Switch to Café Lumière', run: () => undefined },
  { id: 'd', group: 'navigate', label: 'Analytics', keywords: 'Insights', href: '/analytics' },
];

describe('command model (25.4)', () => {
  it('normalises case and accents', () => {
    expect(normalise('  Café LUMIÈRE ')).toBe('cafe lumiere');
  });

  it('keeps everything for empty text and matches every word, in any order, on label or keywords', () => {
    expect(filterCommands(entries, '  ')).toHaveLength(4);
    expect(filterCommands(entries, 'plan').map((e) => e.id)).toEqual(['a', 'b']);
    expect(filterCommands(entries, 'plans month').map((e) => e.id)).toEqual(['b']);
    expect(filterCommands(entries, 'cafe').map((e) => e.id)).toEqual(['c']);
    expect(filterCommands(entries, 'insights').map((e) => e.id)).toEqual(['d']);
    expect(filterCommands(entries, 'nothing like this')).toEqual([]);
  });

  it('moves the active option with arrows (wrapping) and page keys', () => {
    expect(moveActive(0, 3, 'ArrowDown')).toBe(1);
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(1, 3, 'PageDown')).toBe(2);
    expect(moveActive(2, 3, 'PageUp')).toBe(0);
    expect(moveActive(5, 3, 'Enter')).toBe(2);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1);
  });
});

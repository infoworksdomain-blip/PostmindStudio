// BACKLOG 25.4 — the command menu's pure parts: matching typed text against commands and moving
// the active option with the keyboard. Only real destinations and real actions are listed; the
// menu component builds them from the navigation map (nav.ts) and live data.

export type CommandGroup = 'projects' | 'navigate' | 'create' | 'business' | 'appearance';

export interface CommandEntry {
  id: string;
  group: CommandGroup;
  label: string;
  /** Extra words that should find this command (another name for the page). */
  keywords?: string;
  /** A page to open; otherwise `run` is called. */
  href?: string;
  run?: () => void;
}

/** Lower case without accents, so "cafe" finds "Café" and "ANALYTICS" finds "Analytics". */
export function normalise(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
}

/** Every typed word must appear in the label or keywords (order free). Empty text keeps all. */
export function filterCommands<T extends CommandEntry>(entries: readonly T[], query: string): T[] {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = normalise(`${entry.label} ${entry.keywords ?? ''}`);
    return words.every((w) => haystack.includes(w));
  });
}

/** The next active index for an arrow key (wraps), or the same index for any other key. */
export function moveActive(index: number, count: number, key: string): number {
  if (count === 0) return -1;
  if (key === 'ArrowDown') return index < 0 || index >= count - 1 ? 0 : index + 1;
  if (key === 'ArrowUp') return index <= 0 ? count - 1 : index - 1;
  if (key === 'PageDown' || key === 'End') return count - 1;
  if (key === 'PageUp' || key === 'Home') return 0;
  return Math.min(index, count - 1);
}

/** The shortest text that starts a project search (one letter would list everything). */
export const PROJECT_SEARCH_MIN = 2;
/** How long typing pauses before the project search is sent. */
export const PROJECT_SEARCH_DEBOUNCE_MS = 250;
/** How many projects the menu lists. */
export const PROJECT_SEARCH_LIMIT = 8;

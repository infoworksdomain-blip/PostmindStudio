'use client';

import { useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { DURATION_FILTERS, type CategoryOption } from './library-utils';

// Taxonomy filters for /library. Category, duration, mood and tags are server-side filters
// (GET /library/videos); "search" narrows the loaded page by title/description/tags because the
// API has no free-text search endpoint yet.

export interface LibraryFilterState {
  category: string;
  duration: string;
  mood: string;
  tags: string;
  search: string;
}

export const EMPTY_FILTERS: LibraryFilterState = {
  category: '',
  duration: 'any',
  mood: '',
  tags: '',
  search: '',
};

export const selectClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

export function LibraryFilters({
  value,
  categories,
  onChange,
}: {
  value: LibraryFilterState;
  categories: CategoryOption[];
  onChange: (next: LibraryFilterState) => void;
}) {
  // Text inputs are applied on submit so each keystroke doesn't refetch.
  const [draft, setDraft] = useState({ mood: value.mood, tags: value.tags, search: value.search });
  const active =
    value.category || value.duration !== 'any' || value.mood || value.tags || value.search;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onChange({ ...value, ...draft });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Filter the library"
      className="grid grid-cols-1 gap-3 border-y border-border/70 py-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1.4fr_auto] lg:items-end"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="library-category">Category</Label>
        <select
          id="library-category"
          className={selectClass}
          value={value.category}
          onChange={(e) => onChange({ ...value, category: e.target.value })}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {`${'  '.repeat(c.depth)}${c.depth ? '└ ' : ''}${c.label}`}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-duration">Length</Label>
        <select
          id="library-duration"
          className={selectClass}
          value={value.duration}
          onChange={(e) => onChange({ ...value, duration: e.target.value })}
        >
          {DURATION_FILTERS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-mood">Mood</Label>
        <Input
          id="library-mood"
          placeholder="e.g. upbeat"
          value={draft.mood}
          onChange={(e) => setDraft({ ...draft, mood: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-tags">Tags</Label>
        <Input
          id="library-tags"
          placeholder="comma separated"
          value={draft.tags}
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-search">Search this page</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="library-search"
            type="search"
            placeholder="Title, description, tag"
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            className="pl-8"
          />
        </div>
      </div>
      <div className={cn('flex gap-2', 'sm:col-span-2 lg:col-span-1')}>
        <Button type="submit" className="flex-1 lg:flex-none">
          Apply
        </Button>
        {active && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft({ mood: '', tags: '', search: '' });
              onChange(EMPTY_FILTERS);
            }}
          >
            <X /> Clear
          </Button>
        )}
      </div>
    </form>
  );
}

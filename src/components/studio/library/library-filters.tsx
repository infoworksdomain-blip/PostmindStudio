'use client';

import { useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { DURATION_FILTERS, type CategoryOption } from './library-utils';
import { EMPTY_FILTERS, type LibraryFilterState } from './use-library-params';

// The library toolbar (25.10): search first, then category, length, mood and tags, on one calm
// row from lg (no box around it). Category and length apply at once; the text fields apply on
// Enter or Apply so each keystroke doesn't refetch. Category, length, mood and tags are
// server-side filters (GET /library/videos); "search" is a free-text search of the whole library
// (POST /library/search, BACKLOG 13.8) within those filters.

export { EMPTY_FILTERS, type LibraryFilterState };

type Draft = Pick<LibraryFilterState, 'mood' | 'tags' | 'search'>;

const draftOf = (v: LibraryFilterState): Draft => ({
  mood: v.mood,
  tags: v.tags,
  search: v.search,
});

const sameDraft = (a: Draft, b: Draft) =>
  a.mood === b.mood && a.tags === b.tags && a.search === b.search;

export function LibraryFilters({
  value,
  categories,
  onChange,
}: {
  value: LibraryFilterState;
  categories: CategoryOption[];
  onChange: (next: LibraryFilterState) => void;
}) {
  const t = useTranslations('library.filters');
  const tc = useTranslations('common.actions');
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  // When the applied filters change from elsewhere (the URL, Clear, a suggested category), the
  // text fields follow them.
  const [applied, setApplied] = useState<Draft>(() => draftOf(value));
  if (!sameDraft(applied, draftOf(value))) {
    setApplied(draftOf(value));
    setDraft(draftOf(value));
  }
  const active =
    value.category || value.duration !== 'any' || value.mood || value.tags || value.search;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onChange({ ...value, ...draft });
  };

  return (
    <form
      onSubmit={submit}
      role="search"
      aria-label={t('formAria')}
      className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 lg:grid-cols-[minmax(14rem,2fr)_minmax(9rem,1.2fr)_minmax(7rem,0.9fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_auto] lg:items-end"
    >
      <div className="col-span-2 grid gap-1.5 sm:col-span-4 lg:col-span-1">
        <Label htmlFor="library-search" className="text-xs text-muted-foreground">
          {t('search')}
        </Label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
          />
          <Input
            id="library-search"
            type="search"
            placeholder={t('searchPlaceholder')}
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            className="ps-9"
          />
        </div>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="library-category" className="text-xs text-muted-foreground">
          {t('category')}
        </Label>
        <NativeSelect
          id="library-category"
          value={value.category}
          onChange={(e) => onChange({ ...value, ...draft, category: e.target.value })}
        >
          <option value="">{t('allCategories')}</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {`${'  '.repeat(c.depth)}${c.depth ? '└ ' : ''}${c.label}`}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="library-duration" className="text-xs text-muted-foreground">
          {t('length')}
        </Label>
        <NativeSelect
          id="library-duration"
          value={value.duration}
          onChange={(e) => onChange({ ...value, ...draft, duration: e.target.value })}
        >
          {DURATION_FILTERS.map((d) => (
            <option key={d.key} value={d.key}>
              {t(`duration.${d.key}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="library-mood" className="text-xs text-muted-foreground">
          {t('mood')}
        </Label>
        <Input
          id="library-mood"
          placeholder={t('moodPlaceholder')}
          value={draft.mood}
          onChange={(e) => setDraft({ ...draft, mood: e.target.value })}
        />
      </div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="library-tags" className="text-xs text-muted-foreground">
          {t('tags')}
        </Label>
        <Input
          id="library-tags"
          placeholder={t('tagsPlaceholder')}
          value={draft.tags}
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
        />
      </div>
      <div className="col-span-2 flex gap-2 sm:col-span-4 lg:col-span-1">
        <Button type="submit" variant="secondary" className="flex-1 lg:flex-none">
          {tc('apply')}
        </Button>
        {active && (
          <Button type="button" variant="ghost" onClick={() => onChange(EMPTY_FILTERS)}>
            <X /> {t('clear')}
          </Button>
        )}
      </div>
    </form>
  );
}

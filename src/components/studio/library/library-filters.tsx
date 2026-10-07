'use client';

import { useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { DURATION_FILTERS, type CategoryOption } from './library-utils';

// Taxonomy filters for /library. Category, duration, mood and tags are server-side filters
// (GET /library/videos); "search" is a free-text search of the whole library (POST
// /library/search, BACKLOG 13.8), within the chosen category.

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

/**
 * BACKLOG 25.3: superseded by `NativeSelect` (ui/native-select); kept only while screens
 * outside the library (admin, settings, onboarding) still import it.
 */
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
  const t = useTranslations('library.filters');
  const tc = useTranslations('common.actions');
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
      aria-label={t('formAria')}
      className="grid grid-cols-1 gap-3 border-y border-border/70 py-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1.4fr_auto] lg:items-end"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="library-category">{t('category')}</Label>
        <NativeSelect
          id="library-category"
          size="sm"
          value={value.category}
          onChange={(e) => onChange({ ...value, category: e.target.value })}
        >
          <option value="">{t('allCategories')}</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {`${'  '.repeat(c.depth)}${c.depth ? '└ ' : ''}${c.label}`}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-duration">{t('length')}</Label>
        <NativeSelect
          id="library-duration"
          size="sm"
          value={value.duration}
          onChange={(e) => onChange({ ...value, duration: e.target.value })}
        >
          {DURATION_FILTERS.map((d) => (
            <option key={d.key} value={d.key}>
              {t(`duration.${d.key}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-mood">{t('mood')}</Label>
        <Input
          id="library-mood"
          placeholder={t('moodPlaceholder')}
          value={draft.mood}
          onChange={(e) => setDraft({ ...draft, mood: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-tags">{t('tags')}</Label>
        <Input
          id="library-tags"
          placeholder={t('tagsPlaceholder')}
          value={draft.tags}
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="library-search">{t('search')}</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 start-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="library-search"
            type="search"
            placeholder={t('searchPlaceholder')}
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            className="ps-8"
          />
        </div>
      </div>
      <div className={cn('flex gap-2', 'sm:col-span-2 lg:col-span-1')}>
        <Button type="submit" className="flex-1 lg:flex-none">
          {tc('apply')}
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
            <X /> {t('clear')}
          </Button>
        )}
      </div>
    </form>
  );
}

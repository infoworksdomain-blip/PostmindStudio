'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { selectClass } from '../library/library-filters';
import type { CategoryOption } from '../library/library-utils';
import type { AdminLibraryFilters } from './library-admin-types';

// 15.D7 — filters of the staff corpus list (GET /admin/library/videos): licence status (incl.
// "no licence row", A11.1), live/retired, categorisation review, category and title search.

const SEARCH_DEBOUNCE_MS = 300;

function Select({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

export function LibraryAdminFilterBar({
  filters,
  categories,
  onChange,
}: {
  filters: AdminLibraryFilters;
  categories: CategoryOption[];
  onChange: (next: AdminLibraryFilters) => void;
}) {
  const [q, setQ] = useState(filters.q);
  const set = (key: keyof AdminLibraryFilters) => (value: string) =>
    onChange({ ...filters, [key]: value });

  useEffect(() => {
    if (q === filters.q) return;
    const timer = setTimeout(() => onChange({ ...filters, q }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, filters, onChange]);

  return (
    <div
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      role="group"
      aria-label="Corpus filters"
    >
      <div className="grid gap-1">
        <label htmlFor="admin-library-q" className="text-xs text-muted-foreground">
          Search
        </label>
        <Input
          id="admin-library-q"
          className="h-8"
          placeholder="Title, tag or id"
          maxLength={200}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Select
        id="admin-library-licence"
        label="Licence status"
        value={filters.licence}
        onChange={set('licence')}
      >
        <option value="">Any licence</option>
        <option value="missing">No licence row</option>
        <option value="LICENSED">Licensed</option>
        <option value="OWNED">Owned</option>
        <option value="SCRAPED">Scraped</option>
        <option value="NOT_REQUIRED">Not required</option>
      </Select>
      <Select
        id="admin-library-retired"
        label="Status"
        value={filters.retired}
        onChange={set('retired')}
      >
        <option value="false">Live</option>
        <option value="true">Retired</option>
        <option value="">Live and retired</option>
      </Select>
      <Select
        id="admin-library-review"
        label="Categorisation"
        value={filters.review}
        onChange={set('review')}
      >
        <option value="">Any</option>
        <option value="unreviewed">Not reviewed</option>
        <option value="ACCEPTED">Accepted</option>
        <option value="OVERRIDDEN">Overridden</option>
        <option value="REJECTED">Rejected</option>
      </Select>
      <Select
        id="admin-library-category"
        label="Category"
        value={filters.category}
        onChange={set('category')}
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c.slug} value={c.slug}>
            {`${'  '.repeat(c.depth)}${c.label}`}
          </option>
        ))}
      </Select>
    </div>
  );
}

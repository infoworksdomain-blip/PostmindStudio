'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { CategoryOption } from '../library/library-utils';
import type { AdminLibraryFilters } from './library-admin-types';

// 15.D7 — filters of the staff corpus list (GET /admin/library/videos): licence status (incl.
// "no licence row", A11.1), live/retired, categorisation review, category and title search.

const SEARCH_DEBOUNCE_MS = 300;
const SCENARIOS = ['LICENSED', 'OWNED', 'SCRAPED', 'NOT_REQUIRED'] as const;

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
      <NativeSelect size="sm" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </NativeSelect>
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
  const t = useTranslations('admin.library.filters');
  const tl = useTranslations('admin.library');
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
      aria-label={t('groupAria')}
    >
      <div className="grid gap-1">
        <label htmlFor="admin-library-q" className="text-xs text-muted-foreground">
          {t('search')}
        </label>
        <Input
          id="admin-library-q"
          className="h-8"
          placeholder={t('searchPlaceholder')}
          maxLength={200}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Select
        id="admin-library-licence"
        label={t('licence')}
        value={filters.licence}
        onChange={set('licence')}
      >
        <option value="">{t('licenceAny')}</option>
        <option value="missing">{t('licenceMissing')}</option>
        {SCENARIOS.map((s) => (
          <option key={s} value={s}>
            {tl(`scenario.${s}`)}
          </option>
        ))}
      </Select>
      <Select
        id="admin-library-retired"
        label={t('status')}
        value={filters.retired}
        onChange={set('retired')}
      >
        <option value="false">{t('statusLive')}</option>
        <option value="true">{t('statusRetired')}</option>
        <option value="">{t('statusAll')}</option>
      </Select>
      <Select
        id="admin-library-review"
        label={t('review')}
        value={filters.review}
        onChange={set('review')}
      >
        <option value="">{t('reviewAny')}</option>
        <option value="unreviewed">{t('reviewNone')}</option>
        <option value="ACCEPTED">{t('reviewAccepted')}</option>
        <option value="OVERRIDDEN">{t('reviewOverridden')}</option>
        <option value="REJECTED">{t('reviewRejected')}</option>
      </Select>
      <Select
        id="admin-library-category"
        label={t('category')}
        value={filters.category}
        onChange={set('category')}
      >
        <option value="">{t('categoryAll')}</option>
        {categories.map((c) => (
          <option key={c.slug} value={c.slug}>
            {`${'  '.repeat(c.depth)}${c.label}`}
          </option>
        ))}
      </Select>
    </div>
  );
}

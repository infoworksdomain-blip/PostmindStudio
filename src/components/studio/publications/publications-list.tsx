'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApi } from '@/lib/client/api';
import { PLATFORM_LABEL, useFormat } from '@/lib/client/format';
import type { Page, Publication } from '@/lib/client/types';
import { FailureReason } from '../failure-reason';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';
import { NativeSelect } from './native-select';
import { PublicationActions } from './publication-actions';
import { useProjectName } from '@/lib/client/use-project-name';

// BACKLOG 10.5 — Manage: every publication across platforms (spec 14.3), filtered by state and
// platform, cursor-paginated (GET /publications).

export type PublicationFilterKey = 'all' | 'scheduled' | 'live' | 'failed' | 'ended';

export const PUBLICATION_FILTERS: Array<{ key: PublicationFilterKey; states?: string }> = [
  { key: 'all' },
  { key: 'scheduled', states: 'SCHEDULED' },
  { key: 'live', states: 'PUBLISHED,PUBLISHING' },
  { key: 'failed', states: 'FAILED' },
  { key: 'ended', states: 'CANCELLED,TAKEN_DOWN' },
];

/** 15.A8: live view count for the list ("—" before the first metrics poll). */
export function viewsOf(p: Publication, locale: string = DEFAULT_LOCALE, none = '—'): string {
  const views = p.latestMetrics?.views;
  return typeof views === 'number' ? new Intl.NumberFormat(locale).format(views) : none;
}

export type WhenKind = 'published' | 'scheduledFor' | 'created';

/** The moment that matters for a row: when it went live, else when it is due, else created. */
export function whenOf(p: Publication): { kind: WhenKind; iso: string } {
  if (p.publishedAt) return { kind: 'published', iso: p.publishedAt };
  if (p.scheduledFor) return { kind: 'scheduledFor', iso: p.scheduledFor };
  return { kind: 'created', iso: p.createdAt };
}

function PublicationRow({ p, onChanged }: { p: Publication; onChanged: () => void }) {
  const t = useTranslations('publications.list');
  const tf = useTranslations('format');
  const f = useFormat();
  const projectName = useProjectName();
  const state = f.publicationState(p.state);
  const platform = f.platform(p.platform);
  const when = whenOf(p);
  const date = f.date(when.iso);
  return (
    <TableRow>
      <TableCell className="max-w-0 py-3 whitespace-normal md:w-[40%]">
        <Link
          href={`/projects/${p.projectId}`}
          className="block truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {p.project ? projectName(p.project.name) : t('untitled')}
        </Link>
        <span className="block truncate text-xs text-muted-foreground md:hidden">
          {t(`rowMobile.${when.kind}`, { platform, date })}
        </span>
        {p.state === 'FAILED' && p.errorReason && (
          <FailureReason reason={p.errorReason} className="mt-1 block text-xs text-destructive" />
        )}
        {p.metadata?.tiktokMode === 'inbox' && typeof p.metadata.note === 'string' && (
          <span className="mt-1 block text-xs text-muted-foreground">{p.metadata.note}</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell">{platform}</TableCell>
      <TableCell>
        <StateBadge {...state} />
      </TableCell>
      <TableCell className="tabular hidden text-muted-foreground md:table-cell">
        <span className="block text-xs">{t(`when.${when.kind}`)}</span>
        {date}
      </TableCell>
      <TableCell className="tabular hidden text-end md:table-cell">
        {viewsOf(p, f.locale, tf('none'))}
      </TableCell>
      <TableCell className="text-end">
        <PublicationActions publication={p} onChanged={onChanged} />
      </TableCell>
    </TableRow>
  );
}

export function PublicationsList() {
  const t = useTranslations('publications.list');
  const tn = useTranslations('shell.nav.groups');
  const f = useFormat();
  const [filter, setFilter] = useState<PublicationFilterKey>('all');
  const [platform, setPlatform] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const states = PUBLICATION_FILTERS.find((pf) => pf.key === filter)?.states;
  const { data, error, isLoading, mutate } = useApi<Page<Publication>>('/publications', {
    state: states,
    platform: platform || undefined,
    cursor: cursors.at(-1),
    limit: 25,
  });
  const unfiltered = filter === 'all' && !platform;

  return (
    <>
      <PageHeader
        eyebrow={tn('manage')}
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="outline" asChild>
            <Link href="/calendar">
              <CalendarDays /> {t('calendar')}
            </Link>
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t('filtersAria')} className="flex flex-wrap gap-1.5">
          {PUBLICATION_FILTERS.map((pf) => (
            <button
              key={pf.key}
              role="tab"
              aria-selected={filter === pf.key}
              onClick={() => {
                setFilter(pf.key);
                setCursors([]);
              }}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                filter === pf.key
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
              )}
            >
              {t(`filters.${pf.key}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="publication-platform" className="text-xs text-muted-foreground">
            {t('platform')}
          </Label>
          <NativeSelect
            id="publication-platform"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              setCursors([]);
            }}
          >
            <option value="">{t('allPlatforms')}</option>
            {Object.keys(PLATFORM_LABEL).map((key) => (
              <option key={key} value={key}>
                {f.platform(key)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && (
        <div className="flex flex-col gap-2" aria-label={t('loading')}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          title={unfiltered ? t('empty.title') : t('emptyFiltered.title')}
          description={unfiltered ? t('empty.body') : t('emptyFiltered.body')}
          action={
            unfiltered && (
              <Button asChild>
                <Link href="/projects">{t('empty.action')}</Link>
              </Button>
            )
          }
        />
      )}
      {data && data.data.length > 0 && (
        <>
          <Table className="table-fixed md:table-auto">
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.video')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('columns.platform')}</TableHead>
                <TableHead className="w-28 md:w-auto">{t('columns.state')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('columns.when')}</TableHead>
                <TableHead className="hidden text-end md:table-cell">
                  {t('columns.views')}
                </TableHead>
                <TableHead className="w-28 text-end md:w-auto">
                  <span className="sr-only">{t('columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((p) => (
                <PublicationRow key={p.id} p={p} onChanged={() => void mutate()} />
              ))}
            </TableBody>
          </Table>
          <div className="mt-6 flex justify-between">
            <Button
              variant="ghost"
              disabled={cursors.length === 0}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              {t('newer')}
            </Button>
            <Button
              variant="ghost"
              disabled={!data.nextCursor}
              onClick={() =>
                data.nextCursor && setCursors((c) => [...c, data.nextCursor as string])
              }
            >
              {t('older')}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

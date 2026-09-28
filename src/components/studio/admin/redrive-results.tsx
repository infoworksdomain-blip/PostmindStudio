'use client';

import { useTranslations } from 'next-intl';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useFormat } from '@/lib/client/format';
import { Section, StateBadge, Stat } from '../primitives';
import type { RedriveItem, RedriveResponse } from './types';

// The plan (dry run) or outcome (apply) of POST /admin/redrive, one row per project/publication.

/** Server action → catalogue key under admin.redrive.results.actions. */
const ACTION_KEY = {
  resume_planning: 'resumePlanning',
  resume_assets: 'resumeAssets',
  retry_publication: 'retryPublication',
  reenqueue: 'reenqueue',
  skipped: 'skipped',
} as const satisfies Record<RedriveItem['action'], string>;

function ItemRow({ item }: { item: RedriveItem }) {
  const t = useTranslations('admin.redrive.results');
  const f = useFormat();
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground">{t(`kinds.${item.kind}`)}</TableCell>
      <TableCell className="max-w-0 font-mono text-xs md:w-[28%]">
        <span className="block truncate" title={item.id}>
          {item.id}
        </span>
      </TableCell>
      <TableCell className="hidden max-w-0 font-mono text-xs md:table-cell md:w-[22%]">
        <span className="block truncate" title={item.organisationId}>
          {item.organisationId}
        </span>
      </TableCell>
      <TableCell className="whitespace-normal">
        <StateBadge
          label={t(`actions.${ACTION_KEY[item.action]}`)}
          tone={item.action === 'skipped' ? 'warn' : 'good'}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {item.skippedReason ?? f.list(item.jobs ?? [], 'unit')}
        </p>
      </TableCell>
    </TableRow>
  );
}

export function RedriveResults({ result }: { result: RedriveResponse }) {
  const { counts } = result;
  const t = useTranslations('admin.redrive.results');
  const f = useFormat();
  return (
    <Section
      title={result.dryRun ? t('previewTitle') : t('appliedTitle')}
      description={result.dryRun ? t('previewDescription') : t('appliedDescription')}
    >
      <div className="mb-4 grid grid-cols-3 gap-6 border-b border-border/70 pb-4">
        <Stat label={t('considered')} value={f.count(counts.considered)} />
        <Stat
          label={result.dryRun ? t('wouldRedrive') : t('redriven')}
          value={f.count(counts.redriven)}
        />
        <Stat label={t('skipped')} value={f.count(counts.skipped)} />
      </div>
      {result.items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <Table aria-label={t('tableAria')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.kind')}</TableHead>
              <TableHead>{t('columns.id')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('columns.organisation')}</TableHead>
              <TableHead>{t('columns.action')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.map((item) => (
              <ItemRow key={`${item.kind}:${item.id}`} item={item} />
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

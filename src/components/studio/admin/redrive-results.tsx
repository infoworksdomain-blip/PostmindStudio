'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCount } from '@/lib/client/format';
import { Section, StateBadge, Stat } from '../primitives';
import type { RedriveItem, RedriveResponse } from './types';

// The plan (dry run) or outcome (apply) of POST /admin/redrive, one row per project/publication.

const ACTION_LABEL: Record<RedriveItem['action'], string> = {
  resume_planning: 'Resume from planning',
  resume_assets: 'Resume missing assets',
  retry_publication: 'Retry publication',
  reenqueue: 'Re-enqueue stage',
  skipped: 'Skipped',
};

function ItemRow({ item }: { item: RedriveItem }) {
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground capitalize">{item.kind}</TableCell>
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
          label={ACTION_LABEL[item.action]}
          tone={item.action === 'skipped' ? 'warn' : 'good'}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {item.skippedReason ?? (item.jobs ?? []).join(', ')}
        </p>
      </TableCell>
    </TableRow>
  );
}

export function RedriveResults({ result }: { result: RedriveResponse }) {
  const { counts } = result;
  return (
    <Section
      title={result.dryRun ? 'Preview — nothing has changed yet' : 'Re-drive applied'}
      description={
        result.dryRun
          ? 'What an apply with these filters would do right now.'
          : 'Jobs were added to the queues; follow progress on each project.'
      }
    >
      <div className="mb-4 grid grid-cols-3 gap-6 border-b border-border/70 pb-4">
        <Stat label="Considered" value={formatCount(counts.considered)} />
        <Stat
          label={result.dryRun ? 'Would re-drive' : 'Re-driven'}
          value={formatCount(counts.redriven)}
        />
        <Stat label="Skipped" value={formatCount(counts.skipped)} />
      </div>
      {result.items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">Nothing matches these filters.</p>
      ) : (
        <Table aria-label="Re-drive items">
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Id</TableHead>
              <TableHead className="hidden md:table-cell">Organisation</TableHead>
              <TableHead>Action</TableHead>
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

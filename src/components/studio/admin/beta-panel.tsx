'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section, Stat } from '../primitives';

// BACKLOG 14.11 — Admin → Beta: the beta cohort dashboard (GET /admin/beta), enrolling an
// organisation (PUT /admin/organisations/:id/beta — "Plus for 30 days", playbook 10.4) and the
// in-app feedback list (GET /admin/feedback).

export interface BetaOrg {
  organisationId: string;
  cohort: string;
  plusUntil: string | null;
  plusActive: boolean;
  enrolledAt: string;
  videosGenerated: number;
  videosFailed: number;
  videosPublished: number;
  failureRate: number | null;
  costPence: number;
  feedbackCount: number;
}

export interface FeedbackItem {
  id: string;
  organisationId: string;
  userId: string;
  kind: 'bug' | 'idea' | 'praise' | 'other';
  message: string;
  projectId: string | null;
  screen: string;
  createdAt: string;
}

export interface BetaDashboardResponse {
  days: number;
  cohorts: string[];
  totals: {
    organisations: number;
    videosGenerated: number;
    videosFailed: number;
    videosPublished: number;
    costPence: number;
    feedbackCount: number;
    failureRate: number | null;
  };
  organisations: BetaOrg[];
  recentFeedback: FeedbackItem[];
}

const KINDS: readonly FeedbackItem['kind'][] = ['bug', 'idea', 'praise', 'other'];
const WINDOWS = [7, 30, 90] as const;
const NONE = '—';

function EnrolForm({ onSaved }: { onSaved: () => void }) {
  const t = useTranslations('admin.beta.enrol');
  const errorMessage = useErrorMessage();
  const [orgId, setOrgId] = useState('');
  const [cohort, setCohort] = useState('beta-1');
  const [plus, setPlus] = useState(true);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = orgId.trim();
    if (!id || pending) return;
    setPending(true);
    try {
      // plusUntil omitted = Plus for 30 days on enrolment (kept as is on an update); null = none.
      await api(`/admin/organisations/${encodeURIComponent(id)}/beta`, {
        method: 'PUT',
        body: { cohort: cohort.trim(), ...(!plus && { plusUntil: null }) },
      });
      toast.success(t('enrolledToast', { id, cohort: cohort.trim() }));
      setOrgId('');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label={t('formAria')} className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="beta-org">{t('orgIdLabel')}</Label>
          <Input
            id="beta-org"
            className="w-64"
            maxLength={128}
            placeholder={t('orgIdPlaceholder')}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="beta-cohort">{t('cohort')}</Label>
          <Input
            id="beta-cohort"
            className="w-36"
            maxLength={64}
            pattern="[a-z0-9][a-z0-9_\-]*"
            value={cohort}
            onChange={(e) => setCohort(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox
            id="beta-plus"
            checked={plus}
            onCheckedChange={(checked) => setPlus(checked === true)}
          />
          <Label htmlFor="beta-plus" className="font-normal">
            {t('plus')}
          </Label>
        </div>
        <Button type="submit" loading={pending} disabled={!orgId.trim() || !cohort.trim()}>
          {t('submit')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('help')}</p>
    </form>
  );
}

function FeedbackList() {
  const t = useTranslations('admin.beta.feedback');
  const f = useFormat();
  const [kind, setKind] = useState('');
  const res = useApi<{ data: FeedbackItem[]; hasMore: boolean }>('/admin/feedback', {
    kind,
    limit: 50,
  });
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <NativeSelect
          size="sm"
          wrapperClassName="w-auto"
          aria-label={t('kindAria')}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">{t('allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </NativeSelect>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label={t('loadingAria')} className="h-32" />
      ) : res.data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3">
          {res.data.data.map((item) => (
            <li key={item.id} className="rounded-lg border border-border p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                <StatusPill size="sm" className="me-2">
                  {t(`kind.${item.kind}`)}
                </StatusPill>
                {[
                  item.organisationId,
                  item.screen,
                  item.projectId ? t('project', { id: item.projectId }) : null,
                  f.relative(item.createdAt),
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
              </p>
              <p className="whitespace-pre-wrap">{item.message}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function BetaPanel() {
  const t = useTranslations('admin.beta.dashboard');
  const tEnrol = useTranslations('admin.beta.enrol');
  const f = useFormat();
  const percent = (rate: number | null) => (rate === null ? NONE : f.percent(rate));
  const [days, setDays] = useState(30);
  const [cohort, setCohort] = useState('');
  const res = useApi<BetaDashboardResponse>('/admin/beta', { days, cohort });
  const columns: DataTableColumn<BetaOrg>[] = [
    {
      id: 'organisation',
      header: t('col.organisation'),
      cell: (o) => <span className="font-mono text-xs">{o.organisationId}</span>,
    },
    { id: 'cohort', header: t('col.cohort'), cell: (o) => o.cohort },
    {
      id: 'plusUntil',
      header: t('col.plusUntil'),
      cell: (o) =>
        o.plusUntil ? (
          <span className={o.plusActive ? '' : 'text-muted-foreground'}>
            {o.plusActive ? f.date(o.plusUntil) : t('plusEnded', { date: f.date(o.plusUntil) })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('noPlus')}</span>
        ),
    },
    {
      id: 'generated',
      header: t('col.generated'),
      align: 'end',
      cell: (o) => f.number(o.videosGenerated),
    },
    {
      id: 'published',
      header: t('col.published'),
      align: 'end',
      cell: (o) => f.number(o.videosPublished),
    },
    {
      id: 'failureRate',
      header: t('col.failureRate'),
      align: 'end',
      cell: (o) => (
        <span className={(o.failureRate ?? 0) > 0.2 ? 'text-destructive' : undefined}>
          {percent(o.failureRate)}
        </span>
      ),
    },
    { id: 'cost', header: t('col.cost'), align: 'end', cell: (o) => f.pence(o.costPence) },
    {
      id: 'feedback',
      header: t('col.feedback'),
      align: 'end',
      cell: (o) => f.number(o.feedbackCount),
    },
  ];

  return (
    <div className="grid gap-10">
      <Section
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex gap-2">
            <NativeSelect
              size="sm"
              wrapperClassName="w-auto"
              aria-label={t('cohortAria')}
              value={cohort}
              onChange={(e) => setCohort(e.target.value)}
            >
              <option value="">{t('allCohorts')}</option>
              {(res.data?.cohorts ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              size="sm"
              wrapperClassName="w-auto"
              aria-label={t('windowAria')}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {t('window', { days: d })}
                </option>
              ))}
            </NativeSelect>
          </div>
        }
      >
        {res.error ? (
          <ErrorState error={res.error} onRetry={() => void res.mutate()} />
        ) : !res.data ? (
          <Skeleton aria-label={t('loadingAria')} className="h-48" />
        ) : (
          <div className="grid gap-6">
            <div className="grid grid-cols-2 gap-6 md:grid-cols-3 xl:grid-cols-6">
              <Stat label={t('organisations')} value={f.number(res.data.totals.organisations)} />
              <Stat
                label={t('videosGenerated')}
                value={f.number(res.data.totals.videosGenerated)}
              />
              <Stat label={t('published')} value={f.number(res.data.totals.videosPublished)} />
              <Stat
                label={t('failureRate')}
                value={percent(res.data.totals.failureRate)}
                hint={t('failedHint', { count: res.data.totals.videosFailed })}
              />
              <Stat label={t('providerCost')} value={f.pence(res.data.totals.costPence)} />
              <Stat label={t('feedback')} value={f.number(res.data.totals.feedbackCount)} />
            </div>
            {res.data.organisations.length === 0 ? (
              <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />
            ) : (
              <DataTable
                caption={t('title')}
                columns={columns}
                rows={res.data.organisations}
                getRowId={(o) => o.organisationId}
                className="tabular"
              />
            )}
          </div>
        )}
      </Section>
      <Section title={tEnrol('title')} description={tEnrol('description')}>
        <EnrolForm onSaved={() => void res.mutate()} />
      </Section>
      <FeedbackList />
    </div>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section, Stat } from '../primitives';
import { selectClass } from '../library/library-filters';

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
        <Button type="submit" disabled={!orgId.trim() || !cohort.trim() || pending}>
          {pending && <Loader2 className="animate-spin" />}
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
        <select
          aria-label={t('kindAria')}
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">{t('allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
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
                <span className="me-2 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                  {t(`kind.${item.kind}`)}
                </span>
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

  return (
    <div className="grid gap-6">
      <Section
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex gap-2">
            <select
              aria-label={t('cohortAria')}
              className={selectClass}
              value={cohort}
              onChange={(e) => setCohort(e.target.value)}
            >
              <option value="">{t('allCohorts')}</option>
              {(res.data?.cohorts ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              aria-label={t('windowAria')}
              className={selectClass}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {t('window', { days: d })}
                </option>
              ))}
            </select>
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
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pe-4 text-start font-medium">{t('col.organisation')}</th>
                      <th className="py-2 pe-4 text-start font-medium">{t('col.cohort')}</th>
                      <th className="py-2 pe-4 text-start font-medium">{t('col.plusUntil')}</th>
                      <th className="py-2 pe-4 text-end font-medium">{t('col.generated')}</th>
                      <th className="py-2 pe-4 text-end font-medium">{t('col.published')}</th>
                      <th className="py-2 pe-4 text-end font-medium">{t('col.failureRate')}</th>
                      <th className="py-2 pe-4 text-end font-medium">{t('col.cost')}</th>
                      <th className="py-2 text-end font-medium">{t('col.feedback')}</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {res.data.organisations.map((o) => (
                      <tr key={o.organisationId} className="border-t border-border">
                        <td className="py-2 pe-4 font-mono text-xs">{o.organisationId}</td>
                        <td className="py-2 pe-4">{o.cohort}</td>
                        <td className="py-2 pe-4">
                          {o.plusUntil ? (
                            <span className={o.plusActive ? '' : 'text-muted-foreground'}>
                              {o.plusActive
                                ? f.date(o.plusUntil)
                                : t('plusEnded', { date: f.date(o.plusUntil) })}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{t('noPlus')}</span>
                          )}
                        </td>
                        <td className="py-2 pe-4 text-end">{f.number(o.videosGenerated)}</td>
                        <td className="py-2 pe-4 text-end">{f.number(o.videosPublished)}</td>
                        <td
                          className={
                            (o.failureRate ?? 0) > 0.2
                              ? 'py-2 pe-4 text-end text-destructive'
                              : 'py-2 pe-4 text-end'
                          }
                        >
                          {percent(o.failureRate)}
                        </td>
                        <td className="py-2 pe-4 text-end">{f.pence(o.costPence)}</td>
                        <td className="py-2 text-end">{f.number(o.feedbackCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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

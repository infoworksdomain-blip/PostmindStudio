'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { formatDate, formatPence, relativeTime } from '@/lib/client/format';
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

const KIND_LABEL: Record<FeedbackItem['kind'], string> = {
  bug: 'Bug',
  idea: 'Idea',
  praise: 'Praise',
  other: 'Other',
};

const percent = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

function EnrolForm({ onSaved }: { onSaved: () => void }) {
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
      toast.success(`${id} is in ${cohort.trim()}`);
      setOrgId('');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Enrol organisation" className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="beta-org">Organisation id</Label>
          <Input
            id="beta-org"
            className="w-64"
            maxLength={128}
            placeholder="org_…"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="beta-cohort">Cohort</Label>
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
            Plus for 30 days
          </Label>
        </div>
        <Button type="submit" disabled={!orgId.trim() || !cohort.trim() || pending}>
          {pending && <Loader2 className="animate-spin" />}
          Enrol
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        While Plus is active the organisation routes, caps and auto-approves as the Plus plan in
        Studio (never lower than its PostMind plan). Billing is unchanged. Audited.
      </p>
    </form>
  );
}

function FeedbackList() {
  const [kind, setKind] = useState('');
  const res = useApi<{ data: FeedbackItem[]; hasMore: boolean }>('/admin/feedback', {
    kind,
    limit: 50,
  });
  return (
    <Section
      title="Feedback"
      description="Everything customers sent with the Feedback button, newest first."
      actions={
        <select
          aria-label="Feedback kind"
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {(Object.keys(KIND_LABEL) as FeedbackItem['kind'][]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      }
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label="Loading feedback" className="h-32" />
      ) : res.data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No feedback yet.</p>
      ) : (
        <ul className="grid gap-3">
          {res.data.data.map((f) => (
            <li key={f.id} className="rounded-lg border border-border p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                  {KIND_LABEL[f.kind]}
                </span>
                {f.organisationId} · {f.screen}
                {f.projectId && ` · project ${f.projectId}`} · {relativeTime(f.createdAt)}
              </p>
              <p className="whitespace-pre-wrap">{f.message}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function BetaPanel() {
  const [days, setDays] = useState(30);
  const [cohort, setCohort] = useState('');
  const res = useApi<BetaDashboardResponse>('/admin/beta', { days, cohort });

  return (
    <div className="grid gap-6">
      <Section
        title="Beta cohort"
        description="Organisations in the beta programme and how Studio is working for them."
        actions={
          <div className="flex gap-2">
            <select
              aria-label="Cohort"
              className={selectClass}
              value={cohort}
              onChange={(e) => setCohort(e.target.value)}
            >
              <option value="">All cohorts</option>
              {(res.data?.cohorts ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              aria-label="Window"
              className={selectClass}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
        }
      >
        {res.error ? (
          <ErrorState error={res.error} onRetry={() => void res.mutate()} />
        ) : !res.data ? (
          <Skeleton aria-label="Loading beta dashboard" className="h-48" />
        ) : (
          <div className="grid gap-6">
            <div className="grid grid-cols-2 gap-6 md:grid-cols-6">
              <Stat label="Organisations" value={res.data.totals.organisations} />
              <Stat label="Videos generated" value={res.data.totals.videosGenerated} />
              <Stat label="Published" value={res.data.totals.videosPublished} />
              <Stat
                label="Failure rate"
                value={percent(res.data.totals.failureRate)}
                hint={`${res.data.totals.videosFailed} failed`}
              />
              <Stat label="Provider cost" value={formatPence(res.data.totals.costPence)} />
              <Stat label="Feedback" value={res.data.totals.feedbackCount} />
            </div>
            {res.data.organisations.length === 0 ? (
              <EmptyState
                title="No beta organisations yet"
                description="Enrol the first friendly customers below. Recruiting them is people work (playbook 10.4)."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Organisation</th>
                      <th className="py-2 pr-4 font-medium">Cohort</th>
                      <th className="py-2 pr-4 font-medium">Plus until</th>
                      <th className="py-2 pr-4 text-right font-medium">Generated</th>
                      <th className="py-2 pr-4 text-right font-medium">Published</th>
                      <th className="py-2 pr-4 text-right font-medium">Failure rate</th>
                      <th className="py-2 pr-4 text-right font-medium">Cost</th>
                      <th className="py-2 text-right font-medium">Feedback</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {res.data.organisations.map((o) => (
                      <tr key={o.organisationId} className="border-t border-border">
                        <td className="py-2 pr-4 font-mono text-xs">{o.organisationId}</td>
                        <td className="py-2 pr-4">{o.cohort}</td>
                        <td className="py-2 pr-4">
                          {o.plusUntil ? (
                            <span className={o.plusActive ? '' : 'text-muted-foreground'}>
                              {formatDate(o.plusUntil)}
                              {!o.plusActive && ' (ended)'}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">No Plus</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-right">{o.videosGenerated}</td>
                        <td className="py-2 pr-4 text-right">{o.videosPublished}</td>
                        <td
                          className={
                            (o.failureRate ?? 0) > 0.2
                              ? 'py-2 pr-4 text-right text-destructive'
                              : 'py-2 pr-4 text-right'
                          }
                        >
                          {percent(o.failureRate)}
                        </td>
                        <td className="py-2 pr-4 text-right">{formatPence(o.costPence)}</td>
                        <td className="py-2 text-right">{o.feedbackCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>
      <Section
        title="Enrol an organisation"
        description="Adds it to a cohort, or moves it to another one."
      >
        <EnrolForm onSaved={() => void res.mutate()} />
      </Section>
      <FeedbackList />
    </div>
  );
}

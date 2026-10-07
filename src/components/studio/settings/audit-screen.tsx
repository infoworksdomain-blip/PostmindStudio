'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import { SettingsNav } from './settings-nav';

// Phase 18 §2.6 /settings/audit — the organisation's audit log (GET /audit), newest first, with
// a category filter and "load more" (cursor). Known actions get a sentence in the reader's
// language; anything newer shows its code.

export interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  impersonatorUserId: string | null;
  resourceType: string;
  resourceId: string;
}

export interface AuditResponse {
  ok: true;
  data: AuditRow[];
  nextCursor: string | null;
}

const CATEGORIES = [
  'all',
  'member.',
  'org.',
  'billing.',
  'auth.',
  'business.',
  'meta.',
  'staff.',
] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_KEY = {
  all: 'all',
  'member.': 'members',
  'org.': 'organisation',
  'billing.': 'billing',
  'auth.': 'security',
  'business.': 'businesses',
  'meta.': 'connections',
  'staff.': 'staff',
} as const satisfies Record<Category, string>;

/** Actions with a sentence in orgSettings.audit.actions (dots become underscores). */
export const KNOWN_ACTIONS = [
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'org.created',
  'org.renamed',
  'org.updated',
  'org.deleted',
  'billing.checkout_started',
  'billing.subscription_changed',
  'billing.payment_failed',
  'billing.topup_purchased',
  'auth.sign_in',
  'auth.password_changed',
  'auth.2fa_enabled',
  'auth.2fa_disabled',
  'auth.session_revoked',
  'business.created',
  'business.deleted',
  'meta.connected',
  'meta.disconnected',
  'entitlement.override_set',
  'staff.impersonation_started',
  'staff.impersonation_ended',
] as const;
type KnownAction = (typeof KNOWN_ACTIONS)[number];

const ACTION_KEY = Object.fromEntries(
  KNOWN_ACTIONS.map((a) => [a, a.replace(/\./g, '_').replace('2fa', 'twoFactor')]),
) as Record<KnownAction, string>;

type ActionKey =
  | 'member_invited'
  | 'member_joined'
  | 'member_role_changed'
  | 'member_removed'
  | 'org_created'
  | 'org_renamed'
  | 'org_updated'
  | 'org_deleted'
  | 'billing_checkout_started'
  | 'billing_subscription_changed'
  | 'billing_payment_failed'
  | 'billing_topup_purchased'
  | 'auth_sign_in'
  | 'auth_password_changed'
  | 'auth_twoFactor_enabled'
  | 'auth_twoFactor_disabled'
  | 'auth_session_revoked'
  | 'business_created'
  | 'business_deleted'
  | 'meta_connected'
  | 'meta_disconnected'
  | 'entitlement_override_set'
  | 'staff_impersonation_started'
  | 'staff_impersonation_ended';

const ACTOR_KEYS = ['user', 'staff', 'stripe', 'meta', 'system'] as const;
type ActorKey = (typeof ACTOR_KEYS)[number];

/** Catalogue key for an actor without a name (a deleted user, Stripe, Meta, the system). */
function actorKey(actorType: string): ActorKey {
  return (ACTOR_KEYS as readonly string[]).includes(actorType) ? (actorType as ActorKey) : 'system';
}

const isKnown = (action: string): action is KnownAction =>
  (KNOWN_ACTIONS as readonly string[]).includes(action);

function ActionLabel({ action }: { action: string }) {
  const t = useTranslations('orgSettings.audit.actions');
  if (!isKnown(action)) return <code className="text-xs">{action}</code>;
  return <span title={action}>{t(ACTION_KEY[action] as ActionKey)}</span>;
}

export function AuditScreen() {
  const t = useTranslations('orgSettings.audit');
  const tp = useTranslations('orgSettings.page');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [category, setCategory] = useState<Category>('all');
  const query = { action: category === 'all' ? undefined : category, limit: 50 };
  const { data, error, mutate } = useApi<AuditResponse>('/audit', query);
  const [more, setMore] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    setMore([]);
    setCursor(data?.nextCursor ?? null);
  }, [data]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api<AuditResponse>('/audit', { query: { ...query, cursor } });
      setMore((prev) => [...prev, ...page.data]);
      setCursor(page.nextCursor);
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const rows = [...(data?.data ?? []), ...more];
  return (
    <>
      <PageHeader eyebrow={tp('eyebrow')} title={t('title')} description={t('description')} />
      <SettingsNav />
      <Section
        title={t('logTitle')}
        actions={
          <div className="flex items-center gap-2">
            <Label htmlFor="audit-category" className="text-xs text-muted-foreground">
              {t('filter')}
            </Label>
            <NativeSelect
              id="audit-category"
              size="sm"
              wrapperClassName="w-auto"
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${CATEGORY_KEY[c]}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        }
      >
        {error ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : !data ? (
          <Skeleton className="h-48 rounded-lg" aria-label={t('loading')} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.body')} />
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('when')}</TableHead>
                    <TableHead>{t('who')}</TableHead>
                    <TableHead>{t('what')}</TableHead>
                    <TableHead>{t('target')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        <time
                          dateTime={row.occurredAt}
                          title={f.date(row.occurredAt, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        >
                          {f.relative(row.occurredAt)}
                        </time>
                      </TableCell>
                      <TableCell>
                        {row.actorName ?? t(`actors.${actorKey(row.actorType)}`)}
                        {row.impersonatorUserId && (
                          <StatusPill tone="warn" size="sm" className="ms-2">
                            {t('viaStaff')}
                          </StatusPill>
                        )}
                      </TableCell>
                      <TableCell>
                        <ActionLabel action={row.action} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <span className="font-mono" dir="ltr">
                          {row.resourceType}:{row.resourceId.slice(0, 12)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {moreError && <p className="mt-3 text-sm text-destructive">{moreError}</p>}
            {cursor && (
              <div className="mt-4">
                <Button variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                  {t('loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </Section>
    </>
  );
}

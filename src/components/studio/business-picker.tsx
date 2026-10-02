'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { StudioCapability } from '@/lib/rbac';
import { useBusiness } from './business-context';
import { useCan } from './use-can';

// Header business picker. Phase 18 §2.11 (standalone): GET /businesses lists the organisation's
// own businesses (studio.businesses); the picker selects one (the first by default) and adds new
// ones inline (POST /businesses). BACKLOG 13.34 (core mode): Core has no list-businesses yet, the
// API answers 501 and the switcher stays a typed business id, saying why.

export interface BusinessSummary {
  id: string;
  name: string;
  domain?: string;
}

export interface BusinessesResponse {
  ok: true;
  data: BusinessSummary[];
  /** Phase 18: true when Studio owns the list (businesses can be added here). */
  local?: boolean;
}

/** en-GB text of shell.business.listPending (tests assert against it). */
export const BUSINESS_LIST_PENDING_HINT =
  'The business list is waiting for PostMind Core: type the business id.';

const SELECT_CLASS =
  'h-8 w-36 lg:w-48 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function AddBusinessForm({
  onAdded,
  onCancel,
}: {
  onAdded: (business: BusinessSummary) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const t = useTranslations('shell.business');
  const errorMessage = useErrorMessage();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        setSaving(true);
        try {
          const res = await api<{ business: BusinessSummary }>('/businesses', {
            method: 'POST',
            body: { name: trimmed },
            idempotencyKey: newIdempotencyKey(),
          });
          toast.success(t('created', { name: res.business.name }));
          setName('');
          await onAdded(res.business);
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label
        htmlFor="business-new"
        className="sr-only text-xs whitespace-nowrap text-muted-foreground xl:not-sr-only"
      >
        {t('addLabel')}
      </label>
      <Input
        id="business-new"
        className="h-8 w-36 lg:w-44"
        placeholder={t('addPlaceholder')}
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={!name.trim() || saving}>
        {t('addSubmit')}
      </Button>
      {onCancel && (
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('addCancel')}
        </Button>
      )}
    </form>
  );
}

function BusinessSelect({
  businesses,
  onAdded,
}: {
  businesses: BusinessSummary[];
  /** Absent = the list is PostMind Core's (no adding here). */
  onAdded?: (business: BusinessSummary) => Promise<void>;
}) {
  const t = useTranslations('shell.business');
  const { businessId, setBusinessId } = useBusiness();
  const [adding, setAdding] = useState(false);
  const known = businesses.some((b) => b.id === businessId);
  const first = businesses[0]?.id;
  // A stored id that is not (or no longer) one of the organisation's: pick the first business.
  useEffect(() => {
    if (!known && first) setBusinessId(first);
  }, [known, first, setBusinessId]);
  if (adding && onAdded)
    return (
      <AddBusinessForm
        onAdded={async (b) => {
          await onAdded(b);
          setAdding(false);
        }}
        onCancel={() => setAdding(false)}
      />
    );
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="business-select"
        className="sr-only text-xs whitespace-nowrap text-muted-foreground xl:not-sr-only"
      >
        {t('label')}
      </label>
      <select
        id="business-select"
        className={SELECT_CLASS}
        value={known ? (businessId ?? '') : ''}
        onChange={(e) => setBusinessId(e.target.value || null)}
      >
        <option value="" disabled>
          {t('choose')}
        </option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.domain ? `${b.name} · ${b.domain}` : b.name}
          </option>
        ))}
      </select>
      {onAdded && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t('add')}
          title={t('add')}
          onClick={() => setAdding(true)}
        >
          <Plus />
        </Button>
      )}
    </div>
  );
}

function BusinessIdForm({ hint }: { hint?: string }) {
  const t = useTranslations('shell.business');
  const tc = useTranslations('common.actions');
  const { businessId, setBusinessId } = useBusiness();
  const [draft, setDraft] = useState('');
  return (
    <form
      className="flex items-center gap-2"
      title={hint}
      onSubmit={(e) => {
        e.preventDefault();
        setBusinessId(draft || businessId);
        setDraft('');
      }}
    >
      <label
        htmlFor="business-id"
        className="sr-only text-xs whitespace-nowrap text-muted-foreground xl:not-sr-only"
      >
        {t('label')}
      </label>
      <Input
        id="business-id"
        className="h-8 w-36 lg:w-44"
        placeholder={businessId ?? t('idPlaceholder')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-describedby={hint ? 'business-id-hint' : undefined}
      />
      {hint && (
        <span id="business-id-hint" className="sr-only">
          {hint}
        </span>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={!draft}>
        {tc('switch')}
      </Button>
    </form>
  );
}

export function BusinessSwitcher() {
  const t = useTranslations('shell.business');
  const { ready, setBusinessId } = useBusiness();
  const { data, error, mutate } = useApi<BusinessesResponse>(
    ready ? '/businesses' : null,
    undefined,
    { shouldRetryOnError: false },
  );
  // Adding a business needs business:manage; the others pick from the list only.
  const mayAdd = useCan(StudioCapability.BusinessManage);
  if (!ready) return null;
  const added = async (business: BusinessSummary) => {
    await mutate();
    setBusinessId(business.id);
  };
  const local = data?.local === true;
  if (data && data.data.length > 0)
    return <BusinessSelect businesses={data.data} onAdded={local && mayAdd ? added : undefined} />;
  // Standalone with no business yet: the first one is added right here.
  if (data && local) return mayAdd ? <AddBusinessForm onAdded={added} /> : null;
  // Core mode only: businesses live in PostMind (list 501 until Core ships it), so the id is typed.
  // Standalone before an organisation exists (403 no_organisation) has nothing to switch yet.
  if (error?.code === 'no_organisation') return null;
  return <BusinessIdForm hint={error?.status === 501 ? t('listPending') : undefined} />;
}

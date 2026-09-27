'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/client/api';
import { useBusiness } from './business-context';

// Header business switcher. BACKLOG 13.34: with Core's business list (GET /businesses) it is a
// picker; until Core ships list-businesses the API answers 501 and the switcher stays a typed
// business id, saying why.

export interface BusinessSummary {
  id: string;
  name: string;
  domain?: string;
}

interface BusinessesResponse {
  ok: true;
  data: BusinessSummary[];
}

export const BUSINESS_LIST_PENDING_HINT =
  'The business list is waiting for PostMind Core: type the business id.';

const SELECT_CLASS =
  'h-8 w-48 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function BusinessSelect({ businesses }: { businesses: BusinessSummary[] }) {
  const { businessId, setBusinessId } = useBusiness();
  const known = businesses.some((b) => b.id === businessId);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="business-select" className="text-xs whitespace-nowrap text-muted-foreground">
        Business
      </label>
      <select
        id="business-select"
        className={SELECT_CLASS}
        value={known ? (businessId ?? '') : ''}
        onChange={(e) => setBusinessId(e.target.value || null)}
      >
        <option value="" disabled>
          Choose a business
        </option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.domain ? `${b.name} · ${b.domain}` : b.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function BusinessIdForm({ hint }: { hint?: string }) {
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
      <label htmlFor="business-id" className="text-xs whitespace-nowrap text-muted-foreground">
        Business
      </label>
      <Input
        id="business-id"
        className="h-8 w-44"
        placeholder={businessId ?? 'PostMind business id'}
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
        Switch
      </Button>
    </form>
  );
}

export function BusinessSwitcher() {
  const { ready } = useBusiness();
  const { data, error } = useApi<BusinessesResponse>(ready ? '/businesses' : null, undefined, {
    shouldRetryOnError: false,
  });
  if (!ready) return null;
  if (data && data.data.length > 0) return <BusinessSelect businesses={data.data} />;
  return <BusinessIdForm hint={error?.status === 501 ? BUSINESS_LIST_PENDING_HINT : undefined} />;
}

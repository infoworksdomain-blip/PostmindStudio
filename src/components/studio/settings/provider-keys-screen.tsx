'use client';

import { useTranslations } from 'next-intl';
import { StudioCapability } from '@/lib/rbac';
import { PlanLockBadge } from '../billing/plan-lock-badge';
import { useMe } from '../account/use-me';
import { PageHeader } from '../primitives';
import { useCan } from '../use-can';
import { ByocKeysPanel } from './byoc-keys-panel';

// BACKLOG 25.12 — Settings → Provider keys (/settings/provider-keys): an organisation's own AI
// provider keys (BYOC, P1). It was a panel at the bottom of Connections; the panel is unchanged.
// Members who cannot manage connections are told who can instead of seeing an empty page.

export function ProviderKeysScreen() {
  const t = useTranslations('account.providerKeys');
  const tn = useTranslations('settingsNav');
  const known = Boolean(useMe().data?.me?.capabilities);
  const mayManage = useCan(StudioCapability.ConnectionsManage, false);
  return (
    <>
      <PageHeader
        eyebrow={tn('title')}
        title={tn('items.providerKeys')}
        description={t('description')}
        actions={<PlanLockBadge feature="byocProviderKeys" />}
      />
      {known && !mayManage ? (
        <p role="note" className="text-sm text-muted-foreground">
          {tn('providerKeysOwners')}
        </p>
      ) : (
        <ByocKeysPanel />
      )}
    </>
  );
}

'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StudioCapability } from '@/lib/rbac';
import { useBusiness } from '../business-context';
import { useCan } from '../use-can';
import { WriteGate } from '../write-gate';
import { EmptyState, PageHeader } from '../primitives';
import { BusinessHashtagsPanel } from '../hashtags/business-hashtags-panel';
import { BusinessDetailsCard } from './business-details-card';
import { BrandKitsPanel } from './brand-kits-panel';
import { ImageLibraryPanel } from './image-library-panel';
import { ProfilePanel } from './profile-panel';
import { ScanPanel } from './scan-panel';
import { StyleMemoryPanel } from './style-memory-panel';
import { VoiceProfilesPanel } from './voice-profiles-panel';

// BACKLOG 10.9 — the selected business: what Studio thinks it does (profile), the website scan
// that works that out, brand kits, and the image library built from all of it.
// 20.13: the Hashtags tab (business hashtag + always-include hashtags); ?tab=<tab> opens a tab.

export const BUSINESS_TABS = ['profile', 'scan', 'brand', 'hashtags', 'images', 'learned'] as const;

type TabValue = (typeof BUSINESS_TABS)[number];

export function BusinessScreen() {
  const t = useTranslations('business.screen');
  const tn = useTranslations('shell.nav.groups');
  const { businessId, ready } = useBusiness();
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const requested = useSearchParams()?.get('tab');
  const [tab, setTab] = useState<TabValue>(() =>
    (BUSINESS_TABS as readonly string[]).includes(requested ?? '')
      ? (requested as TabValue)
      : 'profile',
  );

  return (
    <>
      <PageHeader eyebrow={tn('setup')} title={t('title')} description={t('description')} />
      {ready && !businessId && (
        <EmptyState
          illustration="business"
          title={t('pickFirst.title')}
          description={t('pickFirst.body')}
        />
      )}
      {businessId && !mayWrite && (
        <p role="note" className="mb-4 text-sm text-muted-foreground">
          {t('readOnly')}
        </p>
      )}
      {businessId && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="gap-6">
          <div className="max-w-full overflow-x-auto">
            <TabsList variant="line">
              {BUSINESS_TABS.map((value) => (
                <TabsTrigger key={value} value={value} className="px-3">
                  {t(`tabs.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="profile">
            <BusinessDetailsCard businessId={businessId} />
            <WriteGate>
              <ProfilePanel businessId={businessId} onGoToScan={() => setTab('scan')} />
            </WriteGate>
          </TabsContent>
          <TabsContent value="scan">
            <WriteGate>
              <ScanPanel businessId={businessId} />
            </WriteGate>
          </TabsContent>
          <TabsContent value="brand" className="grid gap-12">
            <WriteGate>
              <BrandKitsPanel businessId={businessId} />
              <VoiceProfilesPanel businessId={businessId} />
            </WriteGate>
          </TabsContent>
          <TabsContent value="hashtags">
            <WriteGate>
              <BusinessHashtagsPanel businessId={businessId} />
            </WriteGate>
          </TabsContent>
          <TabsContent value="images">
            <ImageLibraryPanel businessId={businessId} />
          </TabsContent>
          <TabsContent value="learned">
            <WriteGate>
              <StyleMemoryPanel businessId={businessId} />
            </WriteGate>
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Building2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBusiness } from '../business-context';
import { EmptyState, PageHeader } from '../primitives';
import { BrandKitsPanel } from './brand-kits-panel';
import { ImageLibraryPanel } from './image-library-panel';
import { ProfilePanel } from './profile-panel';
import { ScanPanel } from './scan-panel';
import { StyleMemoryPanel } from './style-memory-panel';
import { VoiceProfilesPanel } from './voice-profiles-panel';

// BACKLOG 10.9 — the selected business: what Studio thinks it does (profile), the website scan
// that works that out, brand kits, and the image library built from all of it.

export const BUSINESS_TABS = ['profile', 'scan', 'brand', 'images', 'learned'] as const;

type TabValue = (typeof BUSINESS_TABS)[number];

export function BusinessScreen() {
  const t = useTranslations('business.screen');
  const tn = useTranslations('shell.nav.groups');
  const { businessId, ready } = useBusiness();
  const [tab, setTab] = useState<TabValue>('profile');

  return (
    <>
      <PageHeader eyebrow={tn('setup')} title={t('title')} description={t('description')} />
      {ready && !businessId && (
        <EmptyState
          icon={<Building2 className="size-8" strokeWidth={1.5} />}
          title={t('pickFirst.title')}
          description={t('pickFirst.body')}
        />
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
            <ProfilePanel businessId={businessId} onGoToScan={() => setTab('scan')} />
          </TabsContent>
          <TabsContent value="scan">
            <ScanPanel businessId={businessId} />
          </TabsContent>
          <TabsContent value="brand" className="grid gap-12">
            <BrandKitsPanel businessId={businessId} />
            <VoiceProfilesPanel businessId={businessId} />
          </TabsContent>
          <TabsContent value="images">
            <ImageLibraryPanel businessId={businessId} />
          </TabsContent>
          <TabsContent value="learned">
            <StyleMemoryPanel businessId={businessId} />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

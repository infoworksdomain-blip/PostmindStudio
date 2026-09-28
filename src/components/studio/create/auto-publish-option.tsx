'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { AUTO_PUBLISH_CONNECTION, connectionsFor } from '../automation/automation';
import { isMetaPlatform } from '../connections/platforms';
import { Field, NativeSelect } from '../review/field';

// "Auto-publish when approved" (publishPolicy AUTO_ON_APPROVAL): one connected account per
// platform. Instagram and Facebook accounts are the ones PostMind Core registered with Studio;
// they are connected in PostMind settings, not here.

export function AutoPublishOption({
  enabled,
  onToggle,
  platforms,
  accounts,
  onAccount,
  connections,
  businessId,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  platforms: string[];
  accounts: Record<string, string>;
  onAccount: (platform: string, connectionId: string) => void;
  connections: PlatformConnection[] | undefined;
  businessId: string | null;
}) {
  const t = useTranslations('create.autoPublish');
  const tc = useTranslations('connections');
  const f = useFormat();
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border/70 p-3">
      <legend className="sr-only">{t('legend')}</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-foreground"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          {t('toggle')}
          <span className="block text-xs text-muted-foreground">{t('toggleHint')}</span>
        </span>
      </label>
      {enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          {platforms.map((platform) => {
            const label = f.platform(platform);
            const options = connectionsFor(platform, connections, businessId);
            const id = `auto-publish-${platform}`;
            return (
              <Field
                key={platform}
                id={id}
                label={t('account', { platform: label })}
                hint={
                  options.length === 0 &&
                  isMetaPlatform(AUTO_PUBLISH_CONNECTION[platform] ?? '') ? (
                    <>
                      {t('noAccount')} {tc('meta.guidance')}
                    </>
                  ) : options.length === 0 ? (
                    <>
                      {t('noAccount')}{' '}
                      <Link href="/connections" className="underline">
                        {t('connectOne')}
                      </Link>
                    </>
                  ) : undefined
                }
              >
                <NativeSelect
                  id={id}
                  value={accounts[platform] ?? ''}
                  disabled={options.length === 0}
                  onChange={(e) => onAccount(platform, e.target.value)}
                >
                  <option value="">{t('dontAutoPublish')}</option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.platformAccountName}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

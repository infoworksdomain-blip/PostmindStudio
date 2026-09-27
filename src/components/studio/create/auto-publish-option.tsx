'use client';

import Link from 'next/link';
import { PLATFORM_LABEL } from '@/lib/client/format';
import type { PlatformConnection } from '@/lib/client/types';
import { AUTO_PUBLISH_CONNECTION, connectionsFor } from '../automation/automation';
import { Field, NativeSelect } from '../review/field';

// "Auto-publish when approved" (publishPolicy AUTO_ON_APPROVAL): one connected account per
// platform. Instagram and Facebook publish through Engagement's accounts, which Studio cannot
// list yet, so they are shown as unavailable rather than silently skipped.

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
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border/70 p-3">
      <legend className="sr-only">Auto-publish</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-foreground"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          Auto-publish when approved
          <span className="block text-xs text-muted-foreground">
            As soon as the video is approved — by you or automatically — it is posted to the
            accounts below.
          </span>
        </span>
      </label>
      {enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          {platforms.map((platform) => {
            const label = PLATFORM_LABEL[platform] ?? platform;
            if (!AUTO_PUBLISH_CONNECTION[platform])
              return (
                <p key={platform} className="text-xs text-muted-foreground">
                  {label}: not available for auto-publish yet — publish it from the review screen.
                </p>
              );
            const options = connectionsFor(platform, connections, businessId);
            const id = `auto-publish-${platform}`;
            return (
              <Field
                key={platform}
                id={id}
                label={`${label} account`}
                hint={
                  options.length === 0 ? (
                    <>
                      No connected account.{' '}
                      <Link href="/connections" className="underline">
                        Connect one
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
                  <option value="">Don’t auto-publish</option>
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

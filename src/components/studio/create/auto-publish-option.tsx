'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Link2Off } from 'lucide-react';
import { useFormat } from '@/lib/client/format';
import type { MetaConnectInfo, PlatformConnection } from '@/lib/client/types';
import {
  AUTO_PUBLISH_CONNECTION,
  connectionsFor,
  hasConnectedAccount,
  publishablePlatforms,
} from '../automation/automation';
import { isMetaPlatform } from '../connections/platforms';
import { Field, NativeSelect } from '../review/field';
import type { CreateSource } from './body';
import { PLATFORM_OPTIONS } from './formats';

// "Post to" on Create (20.12): where the finished video or slideshow is posted. "Platforms" are
// the formats Studio renders; "accounts" are the connected social accounts it posts to. With no
// connected account the section says so (the work is saved for review) and links to Connections;
// otherwise it shows "Auto-publish when approved" and one account picker per chosen platform
// that has an account, pre-selected when the platform has exactly one (automation.ts
// resolveAccounts). It sits in the main form, not behind Options, for every source.

export interface AutoPublishOptionProps {
  source: CreateSource;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** The chosen render platforms (the template's when one is used). */
  platforms: string[];
  /** Resolved accounts (choice or the only account), keyed by render platform. */
  accounts: Record<string, string>;
  onAccount: (platform: string, connectionId: string) => void;
  connections: PlatformConnection[] | undefined;
  businessId: string | null;
  /** GET /platform-connections `meta.connect`: 'core' = Instagram / Facebook live in PostMind. */
  metaConnect?: MetaConnectInfo['connect'];
}

export function AutoPublishOption(props: AutoPublishOptionProps) {
  const t = useTranslations('create.autoPublish');
  const { connections, businessId } = props;
  if (!connections) return null;
  if (!hasConnectedAccount(connections, businessId))
    return (
      <p
        role="status"
        className="flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
      >
        <Link2Off className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden />
        <span>
          {t('noAccounts', { source: props.source })}{' '}
          <Link href="/connections" className="text-foreground underline underline-offset-2">
            {t('connectAccount')}
          </Link>
        </span>
      </p>
    );
  return <PostTo {...props} />;
}

function PostTo({
  source,
  enabled,
  onToggle,
  platforms,
  accounts,
  onAccount,
  connections,
  businessId,
  metaConnect,
}: AutoPublishOptionProps) {
  const t = useTranslations('create.autoPublish');
  const tc = useTranslations('connections');
  const f = useFormat();
  const withAccount = platforms.filter(
    (p) => connectionsFor(p, connections, businessId).length > 0,
  );
  const without = platforms.filter((p) => !withAccount.includes(p));
  const coreMeta =
    metaConnect === 'core' && without.some((p) => isMetaPlatform(AUTO_PUBLISH_CONNECTION[p] ?? ''));
  // Platforms this business could post to, for "none of your accounts posts to these".
  const postable = publishablePlatforms(
    PLATFORM_OPTIONS.map((o) => o.platform),
    connections,
    businessId,
  );
  return (
    <fieldset
      id="create-post-to"
      className="flex flex-col gap-3 rounded-xl border border-border/70 p-3"
    >
      <legend className="px-1 text-xs font-medium text-muted-foreground">{t('legend')}</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-foreground"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          {t('toggle')}
          <span className="block text-xs text-muted-foreground">
            {enabled ? t('toggleHint') : t('offHint', { source })}
          </span>
        </span>
      </label>
      {withAccount.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('noMatching', {
            platforms: f.list(postable.map((p) => f.platform(p))),
          })}{' '}
          <Link href="/connections" className="underline">
            {t('connectAccount')}
          </Link>
        </p>
      )}
      {enabled && withAccount.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {withAccount.map((platform) => {
            const options = connectionsFor(platform, connections, businessId);
            const id = `auto-publish-${platform}`;
            return (
              <Field
                key={platform}
                id={id}
                label={t('account', { platform: f.platform(platform) })}
              >
                <NativeSelect
                  id={id}
                  value={accounts[platform] ?? ''}
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
      {enabled && withAccount.length > 0 && without.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('notPosted', { platforms: f.list(without.map((p) => f.platform(p))) })}{' '}
          {coreMeta ? (
            tc('meta.guidance')
          ) : (
            <Link href="/connections" className="underline">
              {t('connectAccount')}
            </Link>
          )}
        </p>
      )}
    </fieldset>
  );
}

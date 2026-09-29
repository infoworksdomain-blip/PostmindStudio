import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import type { WebsiteScan } from '@/components/studio/business/types';
import { useLocaleSwitch } from '@/components/studio/i18n/intl-provider';
import { useApi } from '@/lib/client/api';
import { LOCALE_INFO, LOCALES } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { DEMO_BUSINESS_ID } from '../api/ids';
import { Chapter, Code, Panel, Pill, SceneThumb, TourHeader, Toc, useSectionScroll } from './ui';
import { WHATS_NEW, type WhatsNewItem } from './whats-new-data';

// #/tour/whats-new — what Phase 16, Phase 17, Cloudflare R2 and the single-server deployment
// added, each with a "See it" deep link. English only, like every tour page; the screens behind
// the links follow the language chosen here or in the header.

const seeClass =
  'inline-flex items-center gap-0.5 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

function LocaleStrip() {
  const { locale, setLocale } = useLocaleSwitch();
  return (
    <div className="mt-6">
      <p className="mb-2 text-xs text-muted-foreground">
        Show the Studio screens in (the tour text stays in English):
      </p>
      <div role="radiogroup" aria-label="Interface language" className="flex flex-wrap gap-1.5">
        {LOCALES.map((code) => {
          const info = LOCALE_INFO[code];
          const active = code === locale;
          return (
            <button
              key={code}
              type="button"
              role="radio"
              aria-checked={active}
              lang={code}
              dir={info.dir}
              onClick={() => setLocale(code)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
              )}
            >
              {info.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Item({ item }: { item: WhatsNewItem }) {
  return (
    <li className="grid gap-x-4 gap-y-1 py-3 wrap-anywhere sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,16rem)]">
      <span>
        <Pill tone="data">{item.ref}</Pill>
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{item.title}</p>
        <p className="text-sm text-muted-foreground">{item.line}</p>
      </div>
      <ul className="grid content-start gap-1 text-sm">
        {item.see.map((s) => (
          <li key={`${s.href}${s.label}`}>
            <a href={s.href} className={seeClass}>
              <span className="sr-only">See it: </span>
              {s.label}
              <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
            </a>
          </li>
        ))}
      </ul>
    </li>
  );
}

interface Attempt {
  status: number;
  body: string;
}

/** 17.8: send the scan request with a wording that is not in any catalogue. */
function StatementTry() {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const scans = useApi<{ data: WebsiteScan[] }>(`/businesses/${DEMO_BUSINESS_ID}/scans`);
  const latest = scans.data?.data.find((s) => s.ownershipStatementLocale);
  const request = {
    url: 'https://leedssourdough.co.uk/',
    ownershipConfirmed: true,
    ownershipStatement: {
      locale: 'en-GB',
      messageKey: 'business.scan.ownershipStatement',
      text: 'I may scan this website.',
    },
  };
  const send = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/studio/businesses/${DEMO_BUSINESS_ID}/scan-website`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      setAttempt({ status: res.status, body: JSON.stringify(await res.json(), null, 2) });
    } catch (err) {
      setAttempt({ status: 0, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="statement" className="mt-6 grid scroll-mt-24 gap-4 lg:grid-cols-2">
      <Panel title="Try a tampered statement" meta="POST /businesses/:id/scan-website">
        <p className="mb-3 text-sm text-muted-foreground">
          The Website scan tab always sends the approved wording for the interface language. This
          sends the same request with other words, as a modified client would.
        </p>
        <Code label="request body">{JSON.stringify(request, null, 2)}</Code>
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Send it'}
        </button>
        {attempt && (
          <div className="mt-3" aria-live="polite">
            <Code label={`response ${attempt.status}`}>{attempt.body}</Code>
          </div>
        )}
      </Panel>
      <Panel title="What a scan stores" meta="website_scans (latest with a locale)">
        {latest ? (
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">ownershipStatementLocale</dt>
              <dd className="font-mono">{latest.ownershipStatementLocale}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">ownershipStatementKey</dt>
              <dd className="font-mono break-all">{latest.ownershipStatementKey}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">ownershipStatement</dt>
              <dd>
                <bdi dir="auto" lang={latest.ownershipStatementLocale ?? undefined}>
                  {latest.ownershipStatement}
                </bdi>
              </dd>
            </div>
            <p className="text-xs text-muted-foreground">
              Start a scan in another language (Business → Website scan) and this shows that
              language’s approved text. Older scans keep the text with no locale.
            </p>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Loading the scan history…</p>
        )}
      </Panel>
    </div>
  );
}

export function WhatsNew() {
  useSectionScroll();
  return (
    // English-only tour text: kept left-to-right in every interface language.
    <div lang="en" dir="ltr">
      <TourHeader
        eyebrow="What’s new"
        title={
          <>
            Languages, hardening, <em className="text-primary">one server.</em>
          </>
        }
        lede={
          <p>
            Everything Phase 16, Phase 17, Cloudflare R2 storage and the move to a single server
            added. Each line has a link to the screen or sample that shows it.
          </p>
        }
      >
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Pill tone="data">Sample data</Pill>
          <Pill>{WHATS_NEW.reduce((n, g) => n + g.items.length, 0)} changes</Pill>
        </div>
        <LocaleStrip />
        <Toc
          items={WHATS_NEW.map((g) => ({ id: g.id, label: g.title.split(' — ')[0] ?? g.title }))}
        />
      </TourHeader>
      <div className="divide-y divide-border/70">
        {WHATS_NEW.map((group) => (
          <Chapter
            key={group.id}
            id={group.id}
            index={group.index}
            title={group.title}
            description={group.intro}
          >
            <div className="grid gap-5 lg:grid-cols-[12rem_minmax(0,1fr)]">
              <SceneThumb
                scene={group.scene}
                aspect="1:1"
                className="hidden rounded-xl lg:block"
                alt=""
              />
              <ul className="divide-y divide-border/70 border-y border-border/70">
                {group.items.map((item) => (
                  <Item key={`${item.ref}${item.title}`} item={item} />
                ))}
              </ul>
            </div>
            {group.id === 'phase-17' && <StatementTry />}
          </Chapter>
        ))}
      </div>
    </div>
  );
}

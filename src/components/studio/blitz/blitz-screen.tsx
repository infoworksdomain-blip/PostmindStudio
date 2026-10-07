'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CalendarClock,
  Layers,
  PencilLine,
  RefreshCw,
  Send,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { StudioCapability } from '@/lib/rbac';
import { cn } from '@/lib/utils';
import { useBusiness } from '../business-context';
import { TikTokDraftsHint } from '../connections/tiktok-post-mode';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { useCan } from '../use-can';
import { AutomationReviewDeck } from './automation-review-deck';
import { BlitzCardView, RemixSource } from './blitz-card';
import {
  KEEP_MODES,
  SKIP_REASONS,
  type BlitzCard,
  type BlitzDeck,
  type DecisionResult,
  type KeepMode,
  type SkipReason,
} from './blitz-model';
import { SwipeDeck } from './swipe-deck';
import { useLiveRefetch } from '../live/use-live-refetch';

// 22.4 — /blitz: swipe through ready-made posts. Keep (→) asks how to post it (next free slot by
// default, post now, or edit first); skip (←) can say why, which nudges the mix and says so.
// ?automation=<id> reviews an automation's drafted period instead (automation-review-deck.tsx).

const SKIP_REASON_MS = 6_000;
const RENDERING_POLL_MS = 8_000;
const MODE_ICON = { schedule: CalendarClock, post_now: Send, edit: PencilLine } as const;

export function BlitzScreen() {
  const automationId = useSearchParams()?.get('automation');
  if (automationId) return <AutomationReviewDeck automationId={automationId} />;
  return <BlitzDeckScreen />;
}

function BlitzDeckScreen() {
  const t = useTranslations('blitz');
  const tn = useTranslations('shell.nav.groups');
  const errorText = useErrorMessage();
  const f = useFormat();
  const router = useRouter();
  const { businessId, ready } = useBusiness();
  const mayKeep = useCan(StudioCapability.ProjectWrite);
  const mayPost = useCan(StudioCapability.PublicationWrite);
  // 24.2: while the live stream is open, cards still rendering arrive with their project's event
  // (debounced refresh) instead of a poll every RENDERING_POLL_MS.
  const liveOpen = useRef(false);
  const { data, error, mutate, isLoading } = useApi<{ deck: BlitzDeck }>(
    businessId ? '/blitz' : null,
    { businessId },
    {
      refreshInterval: (latest) =>
        latest && latest.deck.rendering > 0 && !liveOpen.current ? RENDERING_POLL_MS : 0,
    },
  );
  const rendering = (data?.deck.rendering ?? 0) > 0;
  useLiveRefetch(
    '',
    () => void mutate(),
    liveOpen,
    (e) => rendering && e.stage !== null,
  );
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [keeping, setKeeping] = useState<BlitzCard | null>(null);
  const [mode, setMode] = useState<KeepMode>('schedule');
  const [pendingSkip, setPendingSkip] = useState<BlitzCard | null>(null);
  const [remixOpen, setRemixOpen] = useState(false);
  const skipTimer = useRef<number | null>(null);

  const cards = useMemo(
    () => (data?.deck.cards ?? []).filter((c) => !decided.has(c.id)),
    [data, decided],
  );
  const items = useMemo(
    () =>
      cards.map((card) => ({
        ...card,
        label: t('deck.cardLabel', { format: t(`deck.format.${card.format}`), title: card.title }),
      })),
    [cards, t],
  );
  const top = cards[0];

  const hide = (id: string) => setDecided((prev) => new Set([...prev, id]));

  const sendDecision = useCallback(async (card: BlitzCard, body: Record<string, unknown>) => {
    const res = await api<{ result: DecisionResult }>(`/blitz/suggestions/${card.id}/decision`, {
      method: 'POST',
      body,
      idempotencyKey: newIdempotencyKey(),
    });
    return res.result;
  }, []);

  const commitSkip = useCallback(
    async (card: BlitzCard, reason?: SkipReason) => {
      if (skipTimer.current) window.clearTimeout(skipTimer.current);
      skipTimer.current = null;
      setPendingSkip(null);
      try {
        const result = await sendDecision(card, { action: 'skip', ...(reason && { reason }) });
        const notice = result.notice;
        if (notice?.kind === 'fewer_format')
          toast(t('toast.fewerFormat', { format: t(`deck.formatPlural.${notice.format}`) }));
        else if (notice?.kind === 'fewer_angle')
          toast(t('toast.fewerAngle', { angle: notice.angleTitle }));
        else if (notice?.kind === 'less_salesy') toast(t('toast.lessSalesy'));
        else if (notice?.kind === 'at_limit') toast(t('toast.atLimit'));
      } catch (err) {
        toast.error(errorText(err));
        setDecided((prev) => new Set([...prev].filter((id) => id !== card.id)));
      } finally {
        void mutate();
      }
    },
    [sendDecision, t, errorText, mutate],
  );

  // A skip waits a moment for an optional reason, then goes on its own.
  const onSkip = (card: BlitzCard) => {
    if (pendingSkip) void commitSkip(pendingSkip);
    hide(card.id);
    setPendingSkip(card);
    skipTimer.current = window.setTimeout(() => void commitSkip(card), SKIP_REASON_MS);
  };
  useEffect(
    () => () => {
      if (skipTimer.current) window.clearTimeout(skipTimer.current);
    },
    [],
  );

  const onKeep = (card: BlitzCard) => {
    if (pendingSkip) void commitSkip(pendingSkip);
    setMode(mayPost ? 'schedule' : 'edit');
    setKeeping(card);
  };
  const onEdit = (card: BlitzCard) => {
    if (pendingSkip) void commitSkip(pendingSkip);
    void keep(card, 'edit');
  };

  const keep = async (card: BlitzCard, chosen: KeepMode) => {
    setBusy(true);
    try {
      const result = await sendDecision(card, { action: 'keep', mode: chosen });
      hide(card.id);
      setKeeping(null);
      if (result.publish === 'scheduled')
        toast.success(
          result.scheduledFor
            ? t('toast.scheduled', {
                when: f.date(result.scheduledFor, { dateStyle: 'medium', timeStyle: 'short' }),
              })
            : t('toast.scheduledSoon'),
        );
      else if (result.publish === 'posting') toast.success(t('toast.posting'));
      else if (result.publish === 'awaiting_approval') toast(t('toast.awaitingApproval'));
      else if (result.publish === 'no_accounts') toast(t('toast.noAccounts'));
      else toast(t('toast.edit'));
      if (result.downloadOnly.length) toast(t('toast.downloadOnly'));
      if (chosen === 'edit' && result.projectId) router.push(`/projects/${result.projectId}`);
    } catch (err) {
      // 403 quota_exceeded / channel_limit also open the upgrade dialog (api.ts).
      toast.error(errorText(err));
    } finally {
      setBusy(false);
      void mutate();
    }
  };

  const generateMore = async () => {
    try {
      await api('/blitz/refill', {
        method: 'POST',
        body: { businessId },
        idempotencyKey: newIdempotencyKey(),
      });
      toast(t('end.queued'));
      void mutate();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const settings = (
    <Button asChild variant="outline">
      <Link href="/business?tab=angles">
        <SlidersHorizontal /> {t('page.settings')}
      </Link>
    </Button>
  );

  const deck = data?.deck;
  return (
    <>
      <PageHeader
        eyebrow={tn('make')}
        title={t('page.title')}
        description={t('page.description')}
        actions={settings}
      />
      {ready && !businessId && (
        <EmptyState media="business" title={t('page.pickTitle')} description={t('page.pickBody')} />
      )}
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {businessId && isLoading && !data && (
        <div className="flex justify-center">
          <Skeleton
            aria-label={t('deck.loading')}
            className="aspect-[9/16] w-full max-w-[22rem] rounded-[1.75rem]"
          />
        </div>
      )}
      {deck && (
        <div className="grid items-start gap-8 lg:grid-cols-[1fr_minmax(0,24rem)_1fr]">
          <aside className="hidden justify-end pt-10 lg:flex" aria-label={t('deck.remix.title')}>
            {top?.remix && <RemixSource card={top} />}
          </aside>
          <section aria-label={t('page.title')} className="flex flex-col items-center gap-3">
            <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <Layers className="size-3.5" aria-hidden />
              {t('deck.swipesLeft', { count: deck.swipesLeft })}
              {deck.rendering > 0 && (
                <span>· {t('deck.rendering', { count: deck.rendering })}</span>
              )}
            </p>
            {cards.length > 0 && deck.swipesLeft > 0 ? (
              <SwipeDeck
                items={items}
                busy={busy || !mayKeep}
                renderCard={(card, active) => (
                  <BlitzCardView
                    card={card}
                    active={active}
                    onShowRemix={() => setRemixOpen(true)}
                  />
                )}
                onKeep={onKeep}
                onSkip={onSkip}
                onEdit={onEdit}
                footer={
                  pendingSkip && (
                    <div
                      className="flex flex-col items-center gap-2"
                      role="group"
                      aria-label={t('skip.title')}
                    >
                      <p className="text-xs font-medium text-muted-foreground">{t('skip.title')}</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {SKIP_REASONS.map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            onClick={() => void commitSkip(pendingSkip, reason)}
                            className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-xs transition hover:border-foreground/40 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-95"
                          >
                            {t(`skip.reasons.${reason}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                }
              />
            ) : (
              <EndOfDeck deck={deck} onMore={() => void generateMore()} />
            )}
          </section>
          <div className="hidden lg:block" />
        </div>
      )}

      <Dialog open={keeping !== null} onOpenChange={(open) => !open && setKeeping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('keep.title')}</DialogTitle>
            <DialogDescription>{keeping?.title}</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label={t('keep.title')} className="grid gap-2">
            {KEEP_MODES.map((m) => {
              const Icon = MODE_ICON[m];
              const disabled = m !== 'edit' && !mayPost;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={disabled}
                  autoFocus={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3 text-start transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
                    mode === m
                      ? 'border-primary bg-primary/6 shadow-sm'
                      : 'border-border hover:bg-secondary/60',
                  )}
                >
                  <Icon
                    className={cn(
                      'mt-0.5 size-4',
                      mode === m ? 'text-primary' : 'text-muted-foreground',
                    )}
                    aria-hidden
                  />
                  <span>
                    <span className="block text-sm font-medium">{t(`keep.${m}`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`keep.${m}Hint`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {/* 22.7: where the TikTok copy goes when the account sends drafts. */}
          {mode !== 'edit' && <TikTokDraftsHint businessId={businessId} />}
          {keeping && keeping.tier === 'preview' && (
            <p className="text-xs text-muted-foreground">
              {t('keep.previewNote', { units: keeping.allowanceUnits })}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setKeeping(null)}>
              {t('keep.cancel')}
            </Button>
            <Button disabled={busy || !keeping} onClick={() => keeping && void keep(keeping, mode)}>
              {t('keep.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={remixOpen} onOpenChange={setRemixOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh]">
          <SheetHeader>
            <SheetTitle>{t('deck.remix.title')}</SheetTitle>
          </SheetHeader>
          <div className="flex justify-center p-4">{top && <RemixSource card={top} />}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function EndOfDeck({ deck, onMore }: { deck: BlitzDeck; onMore: () => void }) {
  const t = useTranslations('blitz.end');
  const key = deck.paused === 'swipe_cap' ? 'swipes' : deck.paused === 'caps' ? 'caps' : 'empty';
  return (
    <div className="flex w-full max-w-[22rem] flex-col items-center gap-4 rounded-[1.75rem] border border-dashed border-border bg-card/60 px-6 py-14 text-center">
      <span
        aria-hidden
        className="grid size-14 place-items-center rounded-full bg-primary/10 text-primary"
      >
        <Layers className="size-6" />
      </span>
      <h2 className="font-display text-3xl leading-none">{t(`${key}Title`)}</h2>
      <p className="text-sm text-muted-foreground">{t(`${key}Body`)}</p>
      {key === 'empty' && (
        <Button onClick={onMore} variant="outline">
          <RefreshCw /> {t('more')}
        </Button>
      )}
    </div>
  );
}

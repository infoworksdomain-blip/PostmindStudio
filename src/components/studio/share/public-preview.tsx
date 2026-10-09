'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useProjectName } from '@/lib/client/use-project-name';

// BACKLOG 15.E5 / decision P8 — the public smart-preview page (studio.postmind.ai/p/:token, spec
// 4.4). No PostMind session: the token in the URL is the credential. Shows the variants and the
// feedback so far, and takes feedback (name, optional email, message). There is no approve button:
// approval stays inside Studio. Text from the project and from reviewers may be in any content
// language (Arabic, Hindi, Chinese, …): every such element uses dir="auto" / <bdi> so right-to-left
// text renders correctly next to left-to-right UI, and break-words so long CJK / Devanagari runs
// wrap instead of overflowing.
// BACKLOG 16.3 — the page is in the VIEWER’s language (src/i18n/request.ts: studio.locale cookie →
// Accept-Language → en-GB), never the owner’s: nothing here reads the owner’s locale.

export interface PublicVariant {
  id: string;
  platform: string;
  aspectRatio: string;
  durationSec: number;
  videoUrl: string;
}

export interface PublicComment {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface PublicPreviewData {
  project: { name: string; state: string };
  variants: PublicVariant[];
  comments: PublicComment[];
  expiresAt: string;
  canApprove: false;
}

const ASPECT_CLASS: Record<string, string> = {
  '9:16': 'aspect-[9/16] max-w-[18rem]',
  '16:9': 'aspect-video',
  '1:1': 'aspect-square max-w-sm',
  '4:5': 'aspect-[4/5] max-w-sm',
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The API's error envelope ({ error: code, message }) as an ApiError for useErrorMessage. */
function toApiError(res: Response, json: Record<string, unknown>, fallback: string): ApiError {
  return new ApiError(
    res.status,
    typeof json.error === 'string' ? json.error : `http_${res.status}`,
    typeof json.message === 'string' ? json.message : fallback,
  );
}

export function PublicPreview({
  token,
  apiBase = '/api/studio',
}: {
  token: string;
  apiBase?: string;
}) {
  const t = useTranslations('share.preview');
  const f = useFormat();
  const projectName = useProjectName();
  const errorMessage = useErrorMessage();
  const url = `${apiBase}/public/share-links/${encodeURIComponent(token)}`;
  const [data, setData] = useState<PublicPreviewData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const json = await readJson(res);
    if (!res.ok) {
      // A dead link (unknown, expired or revoked token) is always 404.
      setFailed(
        res.status === 404
          ? t('unavailable.notFound')
          : errorMessage(toApiError(res, json, t('unavailable.fallback'))),
      );
      return;
    }
    setData(json as unknown as PublicPreviewData);
  }, [url, t, errorMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch(`${url}/comments`, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          authorName: name,
          body,
          ...(email.trim() && { authorEmail: email.trim() }),
        }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setNotice(errorMessage(toApiError(res, json, t('form.sendFailed'))));
        return;
      }
      setBody('');
      setNotice(t('form.sent'));
      await load();
    } finally {
      setSending(false);
    }
  };

  if (failed)
    return (
      <main className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="font-display text-3xl">{t('unavailable.title')}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{failed}</p>
      </main>
    );
  if (!data)
    return (
      // 26.2: a skeleton of the page (title, intro, the variant grid), not a lone spinner.
      <main className="mx-auto max-w-5xl px-4 py-10" aria-label={t('loading')} aria-busy>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-10 w-2/3" />
        <Skeleton className="mt-3 h-4 w-1/2" />
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="aspect-[9/16] w-full rounded-lg" />
          <Skeleton className="aspect-[9/16] w-full rounded-lg max-sm:hidden" />
          <Skeleton className="aspect-[9/16] w-full rounded-lg max-lg:hidden" />
        </div>
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
        {t('eyebrow')}
      </p>
      <h1 dir="auto" className="mt-2 font-display text-4xl break-words">
        {projectName(data.project.name)}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('intro', {
          expires: f.date(data.expiresAt, { dateStyle: 'full', timeStyle: 'short' }),
        })}
      </p>

      <section
        aria-label={t('variantsAria')}
        className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        {data.variants.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noVariants')}</p>
        )}
        {data.variants.map((v) => (
          <figure key={v.id} className="flex flex-col gap-2">
            <video
              src={v.videoUrl}
              controls
              playsInline
              preload="metadata"
              className={`w-full rounded-lg bg-black ${ASPECT_CLASS[v.aspectRatio] ?? 'aspect-video'}`}
            />
            <figcaption className="text-sm">
              {t('variantCaption', {
                platform: f.platform(v.platform),
                aspectRatio: v.aspectRatio,
                seconds: Math.round(v.durationSec),
              })}
            </figcaption>
          </figure>
        ))}
      </section>

      <section aria-label={t('feedbackAria')} className="mt-10 grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div>
          <h2 className="text-sm font-semibold">{t('feedbackSoFar')}</h2>
          {data.comments.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('noFeedback')}</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {data.comments.map((c) => (
                <li key={c.id} className="rounded-lg border border-border p-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    <bdi className="font-medium text-foreground">{c.authorName}</bdi> ·{' '}
                    {f.date(c.createdAt)}
                  </p>
                  <p dir="auto" className="mt-1 break-words whitespace-pre-wrap">
                    {c.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <form onSubmit={(e) => void submit(e)} className="grid content-start gap-3">
          <h2 className="text-sm font-semibold">{t('form.title')}</h2>
          <label className="grid gap-1 text-sm">
            {t('form.name')}
            <Input
              dir="auto"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('form.email')}
            <Input
              type="email"
              dir="ltr"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('form.feedback')}
            <Textarea
              dir="auto"
              required
              maxLength={2000}
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={sending || !name.trim() || !body.trim()}>
            {sending ? <Loader2 className="animate-spin" /> : <Send className="rtl:-scale-x-100" />}
            {t('form.send')}
          </Button>
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

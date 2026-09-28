'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

// BACKLOG 15.E5 / decision P8 — the public smart-preview page (studio.postmind.ai/p/:token, spec
// 4.4). No PostMind session: the token in the URL is the credential. Shows the variants and the
// feedback so far, and takes feedback (name, optional email, message). There is no approve button:
// approval stays inside Studio. Text from the project and from reviewers may be in any content
// language (Arabic, Hindi, Chinese, …): every such element uses dir="auto" / <bdi> so right-to-left
// text renders correctly next to left-to-right UI, and break-words so long CJK / Devanagari runs
// wrap instead of overflowing.

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

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok',
  instagram_reel: 'Instagram Reel',
  instagram_feed: 'Instagram feed',
  youtube_short: 'YouTube Short',
  youtube: 'YouTube',
  linkedin_video: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook Reel',
  facebook_feed: 'Facebook feed',
};

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

export function PublicPreview({
  token,
  apiBase = '/api/studio',
}: {
  token: string;
  apiBase?: string;
}) {
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
      setFailed(typeof json.message === 'string' ? json.message : 'This preview is unavailable');
      return;
    }
    setData(json as unknown as PublicPreviewData);
  }, [url]);

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
        setNotice(typeof json.message === 'string' ? json.message : 'Could not send feedback');
        return;
      }
      setBody('');
      setNotice('Thanks — your feedback was sent to the team.');
      await load();
    } finally {
      setSending(false);
    }
  };

  if (failed)
    return (
      <main className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="font-display text-3xl">Preview unavailable</h1>
        <p className="mt-3 text-sm text-muted-foreground">{failed}</p>
      </main>
    );
  if (!data)
    return (
      <main className="flex min-h-[50vh] items-center justify-center" aria-label="Loading preview">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
        PostMind Studio · preview for feedback
      </p>
      <h1 dir="auto" className="mt-2 font-display text-4xl break-words">
        {data.project.name}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You can watch and comment. Approving happens inside PostMind Studio. This link expires{' '}
        {new Date(data.expiresAt).toUTCString()}.
      </p>

      <section aria-label="Variants" className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {data.variants.length === 0 && (
          <p className="text-sm text-muted-foreground">No variants have been rendered yet.</p>
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
              {PLATFORM_LABEL[v.platform] ?? v.platform} · {v.aspectRatio} ·{' '}
              {Math.round(v.durationSec)} s
            </figcaption>
          </figure>
        ))}
      </section>

      <section aria-label="Feedback" className="mt-10 grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div>
          <h2 className="text-sm font-semibold">Feedback so far</h2>
          {data.comments.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No feedback yet.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {data.comments.map((c) => (
                <li key={c.id} className="rounded-lg border border-border p-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    <bdi className="font-medium text-foreground">{c.authorName}</bdi> ·{' '}
                    {new Date(c.createdAt).toLocaleString()}
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
          <h2 className="text-sm font-semibold">Leave feedback</h2>
          <label className="grid gap-1 text-sm">
            Your name
            <Input
              dir="auto"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Email (optional, so the team can reply)
            <Input
              type="email"
              dir="ltr"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Feedback
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
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            Send feedback
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

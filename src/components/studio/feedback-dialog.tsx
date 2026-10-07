'use client';

import { useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import { MessageSquarePlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, useErrorMessage } from '@/lib/client/api';
import { ChoiceChips } from '@/components/ui/choice-chips';

// BACKLOG 14.11 — the app shell's Feedback button: POST /api/studio/feedback
// { kind, message ≤ 2000, projectId?, screen }. The screen is the current path; on a project page
// the project is attached unless the user unticks it. PostMind staff read it on Admin → Beta.

export const FEEDBACK_MAX = 2_000;

const KINDS = ['bug', 'idea', 'praise', 'other'] as const;

type Kind = (typeof KINDS)[number];

/** The project a path belongs to (/projects/<id>/…), if any. */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([A-Za-z0-9_-]{8,64})(?:\/|$)/.exec(pathname);
  return match?.[1] ?? null;
}

export function FeedbackButton() {
  const t = useTranslations('shell.feedback');
  const tc = useTranslations('common.actions');
  const errorMessage = useErrorMessage();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('idea');
  const [message, setMessage] = useState('');
  const [attachProject, setAttachProject] = useState(true);
  const [pending, setPending] = useState(false);
  const projectId = projectIdFromPath(pathname);
  const trimmed = message.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || pending) return;
    setPending(true);
    try {
      await api('/feedback', {
        method: 'POST',
        body: {
          kind,
          message: trimmed,
          screen: pathname.slice(0, 200),
          ...(projectId && attachProject && { projectId }),
        },
      });
      toast.success(t('thanks'));
      setMessage('');
      setKind('idea');
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('buttonAria')}>
          <MessageSquarePlus />
          <span className="hidden sm:inline">{t('button')}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('kindLegend')}</legend>
            <ChoiceChips
              type="single"
              label={t('kindAria')}
              value={kind}
              onChange={setKind}
              options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
            />
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="feedback-message">{t('message')}</Label>
            <Textarea
              id="feedback-message"
              rows={5}
              maxLength={FEEDBACK_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
            />
            <p className="text-end text-xs text-muted-foreground tabular">
              {t('characterCount', { count: message.length, max: FEEDBACK_MAX })}
            </p>
          </div>
          {projectId && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="feedback-project"
                checked={attachProject}
                onCheckedChange={(checked) => setAttachProject(checked === true)}
              />
              <Label htmlFor="feedback-project" className="font-normal">
                {t('attachProject')}
              </Label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={!trimmed} loading={pending}>
              {tc('send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

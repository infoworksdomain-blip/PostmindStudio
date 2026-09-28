'use client';

import { useState, type FormEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, MessageSquarePlus } from 'lucide-react';
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
import { api, errorMessage } from '@/lib/client/api';
import { cn } from '@/lib/utils';

// BACKLOG 14.11 — the app shell's Feedback button: POST /api/studio/feedback
// { kind, message ≤ 2000, projectId?, screen }. The screen is the current path; on a project page
// the project is attached unless the user unticks it. PostMind staff read it on Admin → Beta.

export const FEEDBACK_MAX = 2_000;

const KINDS = [
  { value: 'bug', label: 'Something’s broken' },
  { value: 'idea', label: 'An idea' },
  { value: 'praise', label: 'Something I like' },
  { value: 'other', label: 'Other' },
] as const;

type Kind = (typeof KINDS)[number]['value'];

/** The project a path belongs to (/projects/<id>/…), if any. */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([A-Za-z0-9_-]{8,64})(?:\/|$)/.exec(pathname);
  return match?.[1] ?? null;
}

export function FeedbackButton() {
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
      toast.success('Thanks — the PostMind team reads every message');
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
        <Button variant="ghost" size="sm" aria-label="Send feedback">
          <MessageSquarePlus />
          <span className="hidden sm:inline">Feedback</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Tell us what works and what doesn’t. We’ll see which screen you were on.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">What kind of feedback?</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Feedback kind">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.value}
                  onClick={() => setKind(k.value)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    kind === k.value
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="feedback-message">Message</Label>
            <Textarea
              id="feedback-message"
              rows={5}
              maxLength={FEEDBACK_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
            />
            <p className="text-right text-xs text-muted-foreground tabular">
              {message.length}/{FEEDBACK_MAX}
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
                This is about the project I’m looking at
              </Label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || pending}>
              {pending && <Loader2 className="animate-spin" />}
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { ConsentRecorder } from './voice-consent-recorder';
import { VoiceSamplesInput } from './voice-samples-input';
import {
  MAX_CONSENT_CHARS,
  MIN_CONSENT_CHARS,
  useConsentStatement,
  useVoiceErrorMessage,
  type VoiceProfile,
} from './voice-types';

// Spec 10.2 / 13.4 — clone a voice: the speaker's consent (statement + recording + checkbox) and
// 1–5 clean samples, sent as one multipart form to POST /voice-profiles.

interface Draft {
  name: string;
  speaker: string;
  statement: string;
  statementEdited: boolean;
  consent: boolean;
  recording: File | null;
  samples: File[];
}

type DraftProblem = 'name' | 'speaker' | 'statementLength' | 'recording' | 'samples' | 'consent';

/** The first thing missing from a draft (a key under business.voice.cloneDialog.problems). */
function problemOf(d: Draft): DraftProblem | null {
  if (!d.name.trim()) return 'name';
  if (!d.speaker.trim()) return 'speaker';
  const len = d.statement.trim().length;
  if (len < MIN_CONSENT_CHARS || len > MAX_CONSENT_CHARS) return 'statementLength';
  if (!d.recording) return 'recording';
  if (d.samples.length === 0) return 'samples';
  if (!d.consent) return 'consent';
  return null;
}

/** 17.8: the catalogue key of the suggested consent statement (sent when it was not edited). */
export const CONSENT_STATEMENT_KEY = 'business.voice.cloneDialog.consentPhrase';

function toVoiceForm(d: Draft, businessId: string, locale: string): FormData {
  const form = new FormData();
  form.set('name', d.name.trim());
  form.set('businessId', businessId);
  form.set('speakerName', d.speaker.trim());
  form.set('consentStatement', d.statement.trim());
  form.set('consentStatementLocale', locale);
  if (!d.statementEdited) form.set('consentStatementKey', CONSENT_STATEMENT_KEY);
  form.set('consent', 'true');
  if (d.recording) form.set('consentRecording', d.recording);
  for (const s of d.samples) form.append('samples', s);
  return form;
}

export function VoiceCloneDialog({
  open,
  onOpenChange,
  businessId,
  businessName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  businessName: string;
  onCreated: (profile: VoiceProfile) => void;
}) {
  const t = useTranslations('business.voice.cloneDialog');
  const locale = useLocale();
  const consentStatement = useConsentStatement();
  const voiceErrorMessage = useVoiceErrorMessage();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: '',
    speaker: '',
    statement: consentStatement('', businessName),
    statementEdited: false,
    consent: false,
    recording: null,
    samples: [],
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = problemOf(draft);
  const problemText =
    problem === 'statementLength'
      ? t('problems.statementLength', { min: MIN_CONSENT_CHARS, max: MAX_CONSENT_CHARS })
      : problem
        ? t(`problems.${problem}`)
        : undefined;

  function setSpeaker(speaker: string) {
    setDraft((d) => ({
      ...d,
      speaker,
      statement: d.statementEdited ? d.statement : consentStatement(speaker, businessName),
    }));
  }

  async function submit() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ voiceProfile: VoiceProfile }>('/voice-profiles', {
        method: 'POST',
        body: toVoiceForm(draft, businessId, locale),
        idempotencyKey: newIdempotencyKey(),
      });
      onCreated(res.voiceProfile);
      onOpenChange(false);
    } catch (err) {
      setError(voiceErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          id="voice-clone-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="voice-name">{t('name')}</Label>
              <Input
                id="voice-name"
                maxLength={80}
                placeholder={t('namePlaceholder')}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="voice-speaker">{t('speaker')}</Label>
              <Input
                id="voice-speaker"
                maxLength={120}
                value={draft.speaker}
                onChange={(e) => setSpeaker(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="voice-statement">{t('statement')}</Label>
            <Textarea
              id="voice-statement"
              rows={3}
              maxLength={MAX_CONSENT_CHARS}
              value={draft.statement}
              onChange={(e) =>
                setDraft((d) => ({ ...d, statement: e.target.value, statementEdited: true }))
              }
            />
            <p className="text-xs text-muted-foreground">{t('statementHint')}</p>
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{t('recording')}</span>
            <ConsentRecorder
              value={draft.recording}
              onChange={(recording) => setDraft((d) => ({ ...d, recording }))}
            />
          </div>
          <VoiceSamplesInput
            value={draft.samples}
            onChange={(samples) => setDraft((d) => ({ ...d, samples }))}
          />
          <div className="flex items-start gap-2">
            <Checkbox
              id="voice-consent"
              checked={draft.consent}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, consent: v === true }))}
            />
            <Label htmlFor="voice-consent" className="text-sm leading-snug font-normal">
              {t('consent')}
            </Label>
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="voice-clone-form"
            disabled={Boolean(problem) || busy}
            title={problemText}
          >
            {busy && <Loader2 className="animate-spin" />}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

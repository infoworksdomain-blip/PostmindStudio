'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { StateBadge } from '../primitives';
import {
  MAX_PREVIEW_CHARS,
  useVoiceErrorMessage,
  VOICE_STATE_TONE,
  type VoiceProfile,
} from './voice-types';

// One voice profile: state, consent details, a short preview in the cloned voice, delete.

function VoicePreview({ profile }: { profile: VoiceProfile }) {
  const t = useTranslations('business.voice.preview');
  const voiceErrorMessage = useVoiceErrorMessage();
  const [text, setText] = useState(() => t('defaultText'));
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = `voice-preview-${profile.id}`;

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ previewUrl: string; expiresInSec: number }>(
        `/voice-profiles/${encodeURIComponent(profile.id)}/preview`,
        { method: 'POST', body: { text: text.trim() }, idempotencyKey: newIdempotencyKey() },
      );
      setUrl(res.previewUrl);
    } catch (err) {
      setError(voiceErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="sr-only">
        {t('label', { name: profile.name })}
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={text}
          maxLength={MAX_PREVIEW_CHARS}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={busy || !text.trim()}
          onClick={() => void preview()}
          aria-label={t('aria', { name: profile.name })}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Play />} {t('button')}
        </Button>
      </div>
      {url && (
        // key: a new preview replaces the player so it loads the new clip
        <audio
          key={url}
          controls
          autoPlay
          src={url}
          className="h-9 w-full"
          aria-label={t('playerAria', { name: profile.name })}
        >
          <track kind="captions" />
        </audio>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function VoiceProfileCard({
  profile,
  onDelete,
}: {
  profile: VoiceProfile;
  onDelete: () => void;
}) {
  const t = useTranslations('business.voice');
  const f = useFormat();
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-2xl leading-tight">{profile.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[
              profile.speakerName && t('card.speaker', { name: profile.speakerName }),
              t('card.samples', { count: profile.sampleCount }),
              profile.consentGivenAt &&
                t('card.consent', {
                  date: f.date(profile.consentGivenAt, { dateStyle: 'medium' }),
                }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <StateBadge label={t(`states.${profile.state}`)} tone={VOICE_STATE_TONE[profile.state]} />
      </div>
      {profile.state === 'REQUIRES_VERIFICATION' && (
        <p className="text-sm text-muted-foreground">{t('card.verification')}</p>
      )}
      {profile.state === 'READY' && <VoicePreview profile={profile} />}
      <div className="mt-auto">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          aria-label={t('card.deleteAria', { name: profile.name })}
        >
          <Trash2 /> {t('card.delete')}
        </Button>
      </div>
    </li>
  );
}

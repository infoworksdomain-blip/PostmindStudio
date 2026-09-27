'use client';

import { useState } from 'react';
import { Loader2, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { StateBadge } from '../primitives';
import {
  DEFAULT_PREVIEW_TEXT,
  MAX_PREVIEW_CHARS,
  VOICE_STATE,
  voiceErrorMessage,
  type VoiceProfile,
} from './voice-types';

// One voice profile: state, consent details, a short preview in the cloned voice, delete.

function VoicePreview({ profile }: { profile: VoiceProfile }) {
  const [text, setText] = useState(DEFAULT_PREVIEW_TEXT);
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
        Preview text for {profile.name}
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
          aria-label={`Preview ${profile.name}`}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Play />} Preview
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
          aria-label={`Preview of ${profile.name}`}
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
  const state = VOICE_STATE[profile.state];
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-2xl leading-tight">{profile.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[
              profile.speakerName && `Speaker: ${profile.speakerName}`,
              `${profile.sampleCount} sample${profile.sampleCount === 1 ? '' : 's'}`,
              profile.consentGivenAt &&
                `consent ${new Date(profile.consentGivenAt).toLocaleDateString()}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <StateBadge label={state.label} tone={state.tone} />
      </div>
      {profile.state === 'REQUIRES_VERIFICATION' && (
        <p className="text-sm text-muted-foreground">
          ElevenLabs asks for voice verification before this voice can be used.
        </p>
      )}
      {profile.state === 'READY' && <VoicePreview profile={profile} />}
      <div className="mt-auto">
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete ${profile.name}`}>
          <Trash2 /> Delete
        </Button>
      </div>
    </li>
  );
}

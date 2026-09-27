'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { BrandKit } from '@/lib/client/types';
import { voiceProfilesKey } from './voice-profiles-panel';
import { voiceErrorMessage, type VoiceProfile } from './voice-types';

// BACKLOG 13.13 — a brand kit's narration voice: the stock voice or a READY cloned voice of the
// business. Saved straight away with PATCH /brand-kits/:id { voiceProfileId }.

const STOCK = '';

export function VoiceKitSelect({
  kit,
  onSaved,
}: {
  kit: Pick<BrandKit, 'id' | 'name' | 'businessId' | 'voiceProfileId'>;
  onSaved: () => void;
}) {
  const { data } = useApi<{ data: VoiceProfile[] }>(...voiceProfilesKey(kit.businessId));
  const [busy, setBusy] = useState(false);
  const ready = (data?.data ?? []).filter((p) => p.state === 'READY');
  const current = kit.voiceProfileId ?? STOCK;
  const id = `kit-voice-${kit.id}`;

  async function change(value: string) {
    setBusy(true);
    try {
      await api(`/brand-kits/${encodeURIComponent(kit.id)}`, {
        method: 'PATCH',
        body: { voiceProfileId: value === STOCK ? null : value },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`${kit.name} voice saved`);
      onSaved();
    } catch (err) {
      toast.error(voiceErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        Voice
      </label>
      <select
        id={id}
        aria-label={`Voice for ${kit.name}`}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        value={current}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
      >
        <option value={STOCK}>Stock voice (default)</option>
        {ready.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {current !== STOCK && (!data || !ready.some((p) => p.id === current)) && (
          <option value={current} disabled>
            {data ? 'Unavailable voice' : 'Cloned voice'}
          </option>
        )}
      </select>
    </div>
  );
}

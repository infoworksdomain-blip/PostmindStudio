'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AudioLines, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi } from '@/lib/client/api';
import { EmptyState, ErrorState } from '../primitives';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { VoiceCloneDialog } from './voice-clone-dialog';
import { VoiceProfileCard } from './voice-profile-card';
import { voiceErrorMessage, type VoiceProfile } from './voice-types';

// BACKLOG 13.13 — brand voice (spec 10.2, 13.4): the business's cloned voices. A brand kit can
// narrate in a READY voice; deleting a voice revokes it at ElevenLabs and kits fall back to the
// stock voice.

export function voiceProfilesKey(businessId: string) {
  return ['/voice-profiles', { businessId }] as const;
}

export function VoiceProfilesPanel({
  businessId,
  businessName = '',
}: {
  businessId: string;
  businessName?: string;
}) {
  const { data, error, isLoading, mutate } = useApi<{ data: VoiceProfile[] }>(
    ...voiceProfilesKey(businessId),
  );
  const [cloning, setCloning] = useState(false);
  const [deleting, setDeleting] = useState<VoiceProfile | null>(null);
  const refresh = () => void mutate();
  const profiles = (data?.data ?? []).filter((p) => p.state !== 'DELETED');

  async function remove(profile: VoiceProfile): Promise<boolean> {
    try {
      const res = await api<{ deleted: true; brandKitsUnlinked: number }>(
        `/voice-profiles/${encodeURIComponent(profile.id)}`,
        { method: 'DELETE', idempotencyKey: newIdempotencyKey() },
      );
      const kits = res.brandKitsUnlinked;
      toast.success(
        kits > 0
          ? `${profile.name} deleted; ${kits} brand kit${kits === 1 ? '' : 's'} now use the stock voice`
          : `${profile.name} deleted`,
      );
      refresh();
      return true;
    } catch (err) {
      toast.error(voiceErrorMessage(err));
      return false;
    }
  }

  return (
    <section className="grid gap-5" aria-labelledby="voice-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-xl">
          <h2 id="voice-heading" className="font-display text-3xl leading-none">
            Voice
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Clone a real voice, with the speaker’s recorded consent, and pick it in a brand kit to
            narrate its videos. Without one, videos use a stock voice.
          </p>
        </div>
        <Button onClick={() => setCloning(true)}>
          <Plus /> Clone a voice
        </Button>
      </div>
      {error && <ErrorState error={error} onRetry={refresh} />}
      {isLoading && <Skeleton aria-label="Loading voices" className="h-40 rounded-xl" />}
      {data && profiles.length === 0 && (
        <EmptyState
          icon={<AudioLines className="size-8" strokeWidth={1.5} />}
          title="No cloned voice yet"
          description="Narration uses a stock voice until you clone one."
        />
      )}
      {profiles.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Voice profiles">
          {profiles.map((p) => (
            <VoiceProfileCard key={p.id} profile={p} onDelete={() => setDeleting(p)} />
          ))}
        </ul>
      )}
      {cloning && (
        <VoiceCloneDialog
          open
          onOpenChange={setCloning}
          businessId={businessId}
          businessName={businessName}
          onCreated={(p) => {
            toast.success(
              p.state === 'READY' ? `${p.name} is ready` : `${p.name} needs verification`,
            );
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'this voice'}?`}
        description="The voice is revoked at ElevenLabs and can’t be used again. Brand kits using it go back to the stock voice. The consent record is kept."
        confirmLabel="Delete voice"
        onConfirm={() => (deleting ? remove(deleting) : Promise.resolve(true))}
      />
    </section>
  );
}

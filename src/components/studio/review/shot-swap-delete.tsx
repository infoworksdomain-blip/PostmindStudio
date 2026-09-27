'use client';

import { useState } from 'react';
import { ImageIcon, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ImagePicker } from '../slideshow/image-picker';
import { useAction } from './use-action';

// 13.2 — shot strip actions (spec 14.2): swap the shot's visual for an image from the business's
// library (PATCH /shots/:id { imageLibraryId }) or delete the shot (DELETE /shots/:id, which
// re-times the script; the last shot cannot be deleted). Both leave the variants out of date
// until they are re-rendered.

export function ShotSwapDelete({
  shotId,
  index,
  businessId,
  editable,
  isLastShot,
  onChanged,
  onDeleted,
}: {
  shotId: string;
  index: number;
  businessId: string | null;
  editable: boolean;
  isLastShot: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [imageId, setImageId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { pending, run, busy } = useAction();

  async function swap() {
    if (!imageId) return;
    const ok = await run('swap', `/shots/${shotId}`, {
      method: 'PATCH',
      body: { imageLibraryId: imageId },
      success: `Shot ${index + 1} now uses the library image — re-render to see it.`,
    });
    if (ok) {
      setImageId(null);
      onChanged();
    }
  }

  async function remove() {
    const ok = await run('delete', `/shots/${shotId}`, {
      method: 'DELETE',
      success: `Shot ${index + 1} deleted — re-render to update the variants.`,
    });
    setConfirming(false);
    if (ok) onDeleted();
  }

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4 lg:col-span-2">
      {businessId && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Swap from library</span>
          <ImagePicker
            businessId={businessId}
            label={`Library image for shot ${index + 1}`}
            value={imageId}
            onChange={setImageId}
          />
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={swap}
              disabled={!editable || !imageId || busy}
            >
              {pending === 'swap' ? <Loader2 className="animate-spin" /> : <ImageIcon />}
              Use this image
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-sm">Delete shot {index + 1}? The script is re-timed.</span>
            <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
              {pending === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Confirm delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={!editable || isLastShot || busy}
            title={isLastShot ? 'A script needs at least one shot' : undefined}
          >
            <Trash2 /> Delete shot
          </Button>
        )}
      </div>
    </div>
  );
}

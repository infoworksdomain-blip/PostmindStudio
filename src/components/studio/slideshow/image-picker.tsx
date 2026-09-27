'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { ErrorState } from '../primitives';

// Choose a slide image from the business's image library (A6; GET /image-library).

interface LibraryImage {
  id: string;
  previewUrl: string | null;
  altText?: string | null;
  tags?: string[];
}

export function ImagePicker({
  businessId,
  value,
  onChange,
  label,
}: {
  businessId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
}) {
  const { data, error, isLoading, mutate } = useApi<{ data: LibraryImage[] }>('/image-library', {
    businessId,
    limit: 30,
  });
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data)
    return <Skeleton className="h-20 rounded-lg" aria-label="Loading images" />;
  if (data.data.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No images yet —{' '}
        <Link href="/business" className="underline">
          add some to the image library
        </Link>{' '}
        or run auto-populate.
      </p>
    );
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-2 overflow-x-auto pb-1">
      {data.data.map((img, i) => {
        const selected = value === img.id;
        const name = img.altText || img.tags?.slice(0, 2).join(', ') || `Image ${i + 1}`;
        return (
          <button
            key={img.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            onClick={() => onChange(selected ? null : img.id)}
            className={cn(
              'size-16 shrink-0 overflow-hidden rounded-md border-2 bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              selected ? 'border-primary' : 'border-transparent',
            )}
          >
            {img.previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; nothing for next/image to optimise
              <img src={img.previewUrl} alt="" className="size-full object-cover" />
            )}
          </button>
        );
      })}
    </div>
  );
}

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ArrowDown, ArrowUp, ImageIcon, ListOrdered, Loader2, PenLine, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ImagePicker } from '../slideshow/image-picker';
import { hasList, MAX_POST_CHARS, roleOf, waterfall, type DraftPost } from './model';

// One post of the carousel editor (21.6): its text, its picture (change / remove), its place in
// the thread, and an AI rewrite of just this post.

export interface PostCardEditorProps {
  post: DraftPost;
  index: number;
  count: number;
  slides: number[];
  imageUrl: string | null;
  businessId: string | null;
  disabled: boolean;
  rewriting: boolean;
  canRewrite: boolean;
  onChange: (patch: Partial<DraftPost>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onRewrite: () => void;
}

export function PostCardEditor({
  post,
  index,
  count,
  slides,
  imageUrl,
  businessId,
  disabled,
  rewriting,
  canRewrite,
  onChange,
  onMove,
  onRemove,
  onRewrite,
}: PostCardEditorProps) {
  const t = useTranslations('carousel.editor');
  const [picking, setPicking] = useState(false);
  const role = roleOf(index, count);
  const textId = `carousel-post-${post.id}`;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={textId} className="text-sm font-medium">
          {t('postLabel', { n: index + 1 })}{' '}
          <span className="text-xs font-normal text-muted-foreground">
            · {t(`roles.${role}`)}
            {slides.length > 0 && <> · {t('onSlides', { slides: slides.join(', ') })}</>}
          </span>
        </label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('moveUp', { n: index + 1 })}
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('moveDown', { n: index + 1 })}
            disabled={disabled || index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('remove', { n: index + 1 })}
            disabled={disabled || count <= 1}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <textarea
        id={textId}
        value={post.text}
        maxLength={MAX_POST_CHARS}
        rows={4}
        dir="auto"
        disabled={disabled}
        onChange={(e) => onChange({ text: e.target.value })}
        className="rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
      />
      <p className="text-xs text-muted-foreground">
        {t('characters', { count: [...post.text].length, max: MAX_POST_CHARS })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {post.imageId && imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
          <img src={imageUrl} alt="" className="h-12 w-16 rounded-md object-cover" />
        ) : post.imageId ? (
          <span className="text-xs text-muted-foreground">{t('pictureChosen')}</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {role === 'hook' ? t('hookNeedsPicture') : t('noPicture')}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !businessId}
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
        >
          <ImageIcon /> {post.imageId ? t('changePicture') : t('addPicture')}
        </Button>
        {post.imageId && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ imageId: null })}
          >
            {t('removePicture')}
          </Button>
        )}
        {hasList(post.text) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ text: waterfall(post.text) })}
          >
            <ListOrdered /> {t('waterfall')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !canRewrite}
          onClick={onRewrite}
        >
          {rewriting ? <Loader2 className="animate-spin" /> : <PenLine />} {t('rewritePost')}
        </Button>
      </div>
      {picking && businessId && (
        <ImagePicker
          businessId={businessId}
          value={post.imageId}
          label={t('pictureFor', { n: index + 1 })}
          onChange={(imageId) => {
            onChange({ imageId });
            setPicking(false);
          }}
        />
      )}
    </li>
  );
}

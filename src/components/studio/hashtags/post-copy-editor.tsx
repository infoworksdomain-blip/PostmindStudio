'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { PLATFORM_RULES } from '@/lib/studio/platforms/rules';
import type { Platform } from '@/lib/studio/services/catalog';
import { HashtagEditor } from './hashtag-editor';
import { composedLength } from './model';

// 20.13 — one platform's post copy: caption (hook first), hashtag chips with the ≥ 5 rule and
// the platform maximum, the YouTube title, and a counter of caption + hashtags against the
// platform's limit (characters, or bytes for YouTube descriptions). Used by the Publish panel
// and the month plan's item editor.

/** GET /projects/:id/post-copy → platforms.<platform> (services/post-copy.ts). */
export interface PostCopyInfo {
  caption: string;
  hashtags: string[];
  title?: string;
  source: 'owner' | 'generated' | 'none';
  locked: string[];
  min: number;
  max: number;
  captionMaxChars: number;
  captionLimitInBytes: boolean;
  required: string[];
  titleMaxChars: number | null;
}

export interface PostCopyValue {
  caption: string;
  hashtags: string[];
  title?: string;
}

const MIN_HASHTAGS = 5;

/** The editor rules when GET /post-copy is unavailable: the platform's limits, nothing locked. */
export function fallbackCopyInfo(platform: string, caption: string): PostCopyInfo {
  const rules = PLATFORM_RULES[platform as Platform] as
    (typeof PLATFORM_RULES)[Platform] | undefined;
  return {
    caption,
    hashtags: [],
    source: 'none',
    locked: [],
    min: Math.min(MIN_HASHTAGS, rules?.maxHashtags ?? MIN_HASHTAGS),
    max: rules?.maxHashtags ?? 30,
    captionMaxChars: rules?.captionMaxChars ?? 2200,
    captionLimitInBytes: rules?.captionLimitInBytes ?? false,
    required: rules?.requiredHashtags ?? [],
    titleMaxChars: rules?.titleMaxChars ?? null,
  };
}

/** Whether the value satisfies the rules shown in the editor (count, length). */
export function postCopyProblems(
  value: PostCopyValue,
  info: Pick<PostCopyInfo, 'min' | 'max' | 'captionMaxChars' | 'captionLimitInBytes' | 'required'>,
): { short: boolean; over: boolean; tooLong: boolean } {
  const length = composedLength(
    value.caption,
    [...value.hashtags, ...info.required],
    info.captionLimitInBytes,
  );
  return {
    short: value.hashtags.length < info.min,
    over: value.hashtags.length > info.max,
    tooLong: length > info.captionMaxChars,
  };
}

export function PostCopyEditor({
  id,
  platformLabel,
  info,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  platformLabel: string;
  info: PostCopyInfo;
  value: PostCopyValue;
  onChange: (next: PostCopyValue) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('hashtags.copy');
  const length = composedLength(
    value.caption,
    [...value.hashtags, ...info.required],
    info.captionLimitInBytes,
  );
  const tooLong = length > info.captionMaxChars;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {info.titleMaxChars !== null && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-title`} className="text-xs font-medium text-muted-foreground">
            {t('title')}
          </label>
          <Input
            id={`${id}-title`}
            dir="auto"
            value={value.title ?? ''}
            maxLength={info.titleMaxChars}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${id}-caption`} className="text-xs font-medium text-muted-foreground">
          {t('caption')}
        </label>
        <Textarea
          id={`${id}-caption`}
          dir="auto"
          value={value.caption}
          disabled={disabled}
          aria-describedby={`${id}-length`}
          aria-invalid={tooLong ? true : undefined}
          onChange={(e) => onChange({ ...value, caption: e.target.value })}
        />
        <p
          id={`${id}-length`}
          className={cn('text-xs', tooLong ? 'text-destructive' : 'text-muted-foreground')}
        >
          {t(info.captionLimitInBytes ? 'lengthBytes' : 'length', {
            used: length,
            max: info.captionMaxChars,
          })}
          {tooLong && <> · {t('tooLong', { platform: platformLabel })}</>}
        </p>
      </div>
      <HashtagEditor
        id={`${id}-tags`}
        label={t('hashtags')}
        value={value.hashtags}
        locked={info.locked}
        required={info.required}
        min={info.min}
        max={info.max}
        disabled={disabled}
        onChange={(hashtags) => onChange({ ...value, hashtags })}
      />
    </div>
  );
}

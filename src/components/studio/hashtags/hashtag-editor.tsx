'use client';

import { useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Lock, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  cleanHashtag,
  cleanOwnerHashtag,
  DEFAULT_TAG_MAX_CHARS,
  includesTag,
  moveTag,
  splitHashtags,
} from './model';

// 20.13 — hashtag chips: add (Enter, comma or the + button), remove, move earlier / later.
// Locked tags (the business hashtag and the owner's always-hashtags) cannot be removed but can be
// reordered; platform-added tags (#Shorts) are shown, never stored. The counter shows the ≥ min
// rule and the platform maximum. Chevron icons flip in right-to-left layouts.

export interface HashtagEditorProps {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  locked?: string[];
  /** Tags the platform adds itself (shown after the list). */
  required?: string[];
  min?: number;
  max?: number;
  maxChars?: number;
  /** Owner hashtags need a letter (settings); post hashtags do not. */
  ownerRules?: boolean;
  disabled?: boolean;
}

export function HashtagEditor({
  id,
  label,
  value,
  onChange,
  locked = [],
  required = [],
  min,
  max,
  maxChars = DEFAULT_TAG_MAX_CHARS,
  ownerRules = false,
  disabled = false,
}: HashtagEditorProps) {
  const t = useTranslations('hashtags.editor');
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const isLocked = (tag: string) => includesTag(locked, tag);
  const full = max !== undefined && value.length >= max;

  function add() {
    const candidates = splitHashtags(draft);
    if (!candidates.length) return;
    const next = [...value];
    for (const raw of candidates) {
      const tag = ownerRules ? cleanOwnerHashtag(raw, maxChars) : cleanHashtag(raw, maxChars);
      if (!tag) return setProblem(t('invalid', { max: maxChars }));
      if (includesTag(next, tag)) return setProblem(t('duplicate', { tag }));
      if (max !== undefined && next.length >= max) return setProblem(t('tooMany', { max }));
      next.push(tag);
    }
    setProblem(null);
    setDraft('');
    onChange(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  }

  const short = min !== undefined && value.length < min;
  const over = max !== undefined && value.length > max;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {(value.length > 0 || required.length > 0) && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((tag, index) => (
            <li
              key={tag.toLowerCase()}
              className={cn(
                'inline-flex max-w-full items-center gap-0.5 rounded-full border py-0.5 ps-2 pe-1 text-xs',
                isLocked(tag) ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/40',
              )}
            >
              {isLocked(tag) && (
                <Lock className="size-3 shrink-0" aria-label={t('locked', { tag })} />
              )}
              <span className="truncate" dir="auto">
                #{tag}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-5"
                disabled={disabled || index === 0}
                aria-label={t('moveEarlier', { tag })}
                onClick={() => onChange(moveTag(value, index, -1))}
              >
                <ChevronLeft className="rtl:rotate-180" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-5"
                disabled={disabled || index === value.length - 1}
                aria-label={t('moveLater', { tag })}
                onClick={() => onChange(moveTag(value, index, 1))}
              >
                <ChevronRight className="rtl:rotate-180" />
              </Button>
              {!isLocked(tag) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5"
                  disabled={disabled}
                  aria-label={t('remove', { tag })}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
          {required.map((tag) => (
            <li
              key={`required-${tag}`}
              title={t('platformAdded')}
              className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              #{tag}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          disabled={disabled || full}
          placeholder={t('addPlaceholder')}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-count${problem ? ` ${id}-problem` : ''}`}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => draft.trim() && add()}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || full || !draft.trim()}
          onClick={add}
        >
          <Plus />
          {t('add')}
        </Button>
      </div>
      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <p
        id={`${id}-count`}
        className={cn('text-xs', short || over ? 'text-destructive' : 'text-muted-foreground')}
      >
        {min !== undefined && max !== undefined
          ? t('count', { count: value.length, min, max })
          : t('countPlain', { count: value.length })}
        {short && min !== undefined && <> · {t('needMore', { count: min - value.length, min })}</>}
        {over && max !== undefined && <> · {t('tooMany', { max })}</>}
      </p>
    </div>
  );
}

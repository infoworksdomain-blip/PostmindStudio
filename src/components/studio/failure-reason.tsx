'use client';

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import {
  ERROR_CLASSES,
  parseFailure,
  type FailedCheck,
  type ParsedFailure,
} from '@/lib/client/failure-reasons';
import { cn } from '@/lib/utils';

// BACKLOG 17.9 — a stored failure reason (project, shot, publication, export or scan
// `errorReason`) in the reader's language: the sentence for its code (messages → failures.*),
// plus — untranslated — any text the server did not write (a provider's message, a checker's
// reason, a reviewer's note). Unknown reasons are shown exactly as stored.

export const QUALITY_CHECK_CODES = [
  'content_safety',
  'duration_match',
  'black_frames',
  'audio_present',
  'aspect_ratio',
  'codec',
  'audio_sync',
  'caption_sync',
  'watermark',
  'brand_kit',
  'force_approved',
] as const;

export type QualityCheckCode = (typeof QUALITY_CHECK_CODES)[number];

const has = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** A readable label for a code the catalogue does not know (future checks). */
export function humanCode(code: string): string {
  const text = code.replace(/[_.]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Quality-check code → its label in the reader's language. */
export function useQualityCheckLabel(): (code: string) => string {
  const t = useTranslations('review.quality.codes');
  return useCallback(
    (code: string) => (has(QUALITY_CHECK_CODES, code) ? t(code) : humanCode(code)),
    [t],
  );
}

export interface DescribedFailure {
  /** The translated sentence(s). */
  text: string;
  /** Untranslated text from outside Studio (provider message, reviewer note), if any. */
  detail: string | null;
}

/** Stored reason → { text, detail } in the reader's language (null for an empty reason). */
export function useDescribeFailure(): (raw: string | null | undefined) => DescribedFailure | null {
  const t = useTranslations('failures');
  const f = useFormat();
  const locale = useLocale();
  const checkLabel = useQualityCheckLabel();

  return useCallback(
    (raw: string | null | undefined) => {
      if (!raw?.trim()) return null;
      const source = (id: string) => {
        const label = f.platform(id);
        return label === id ? id.charAt(0).toLocaleUpperCase(locale) + id.slice(1) : label;
      };
      const checks = (list: FailedCheck[] = []) =>
        f.list(list.map((c) => `${f.platform(c.platform)} – ${checkLabel(c.check)}`));
      const sentence = (p: ParsedFailure): string => {
        const { params } = p;
        switch (p.code) {
          case 'kill_switch':
            return t('codes.kill_switch', { level: params.level ?? 'other' });
          case 'provider_failure': {
            const cls = params.errorClass ?? 'unknown';
            return t('codes.provider_failure', {
              source: source(params.source ?? ''),
              problem: has(ERROR_CLASSES, cls) ? t(`classes.${cls}`) : cls,
            });
          }
          case 'asset_generation_failed':
            return t('codes.asset_generation_failed', {
              count: params.shots?.length ?? 0,
              shots: f.list((params.shots ?? []).map((n) => f.number(n))),
            });
          case 'quality_failed':
          case 'content_safety_block':
            return t(`codes.${p.code}`, {
              count: params.checks?.length ?? 0,
              checks: checks(params.checks),
            });
          case 'scan_cost_cap':
          case 'scan_images_capped':
            return t(`codes.${p.code}`, { amount: f.pence(params.pence ?? null) });
          default:
            return t(`codes.${p.code}`);
        }
      };
      const parsed = parseFailure(raw);
      if (!parsed) return { text: raw.trim(), detail: null };
      const parts = [sentence(parsed)];
      if (parsed.cause) parts.push(sentence(parsed.cause));
      return {
        text: parts.join(' '),
        detail: parsed.cause?.detail ?? parsed.rawCause ?? parsed.detail,
      };
    },
    [t, f, locale, checkLabel],
  );
}

/** The translated sentence with the untranslated detail after it (in its own direction). */
export function FailureReason({
  reason,
  className,
  detailClassName,
}: {
  reason: string | null | undefined;
  className?: string;
  detailClassName?: string;
}) {
  const describe = useDescribeFailure();
  const described = describe(reason);
  if (!described) return null;
  return (
    <span className={className}>
      {described.text}
      {described.detail && (
        <>
          {' '}
          <bdi dir="auto" className={cn('opacity-80', detailClassName)}>
            {described.detail}
          </bdi>
        </>
      )}
    </span>
  );
}

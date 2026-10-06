import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { ApiError, useErrorMessage } from '@/lib/client/api';

// BACKLOG 22.3 — reusable creators (services/creators.ts presentCreator) as the browser sees them.
// No cost is ever part of this shape.

export type CreatorStatus = 'DRAFT' | 'READY' | 'RETIRED';

export interface Creator {
  id: string;
  businessId: string;
  name: string;
  gender: 'woman' | 'man';
  ageRange: '18-24' | '25-34' | '35-44' | '45-60';
  setting: 'kitchen' | 'living_room' | 'car' | 'outdoors' | 'bathroom' | 'desk' | 'shop';
  appearance: string | null;
  voiceTone: string | null;
  status: CreatorStatus;
  isDefault: boolean;
  useCount: number;
  lastUsedAt: string | null;
  portraitError: string | null;
  portraitSource: 'GENERATED' | 'UPLOAD' | null;
  portraitUrl: string | null;
  createdAt: string;
  retiredAt: string | null;
}

/** Mirrors services/creators.ts MAX_CREATORS_PER_BUSINESS. */
export const MAX_CREATORS = 20;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function creatorsPath(businessId: string): string {
  return `/businesses/${encodeURIComponent(businessId)}/creators`;
}

export function creatorPath(businessId: string, id: string): string {
  return `${creatorsPath(businessId)}/${encodeURIComponent(id)}`;
}

/**
 * The picker's default: the most used READY creator (the API lists READY first, most used
 * first), or null (a new one-off actor) when the business has none.
 */
export function defaultCreatorId(creators: readonly Creator[]): string | null {
  return creators.find((c) => c.status === 'READY' && c.portraitUrl)?.id ?? null;
}

/** API errors as sentences: the creator limit, a real-person refusal, the daily cap. */
export function useCreatorErrorMessage(): (err: unknown) => string {
  const t = useTranslations('business.creators.errors');
  const errorMessage = useErrorMessage();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        const reason = err.details?.reason;
        if (reason === 'creator_limit') return t('limit', { max: MAX_CREATORS });
        if (reason === 'ugc_real_person_refused') return t('realPerson');
        if (reason === 'creator_portrait_daily_cap') return t('dailyCap');
      }
      return errorMessage(err);
    },
    [t, errorMessage],
  );
}

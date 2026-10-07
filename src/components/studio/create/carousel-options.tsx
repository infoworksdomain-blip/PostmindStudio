'use client';

import { useTranslations } from 'next-intl';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/utils';
import {
  CAROUSEL_POSTS_DEFAULT,
  CAROUSEL_POSTS_MAX,
  CAROUSEL_POSTS_MIN,
  CAROUSEL_THREAD_MAX,
  type CarouselTheme,
  type CreateState,
} from './body';

// 21.6 Create → Carousel (post cards): the look (light / dark), how many posts Studio writes,
// and an optional thread the owner already wrote (then Studio uses it instead of writing one).

const THEMES: CarouselTheme[] = ['light', 'dark'];

export function CarouselOptions({
  state,
  onChange,
}: {
  state: Pick<CreateState, 'carouselTheme' | 'carouselPosts' | 'carouselThread'>;
  onChange: (
    next: Partial<Pick<CreateState, 'carouselTheme' | 'carouselPosts' | 'carouselThread'>>,
  ) => void;
}) {
  const t = useTranslations('create.carousel');
  const theme = state.carouselTheme ?? 'light';
  const posts = state.carouselPosts ?? CAROUSEL_POSTS_DEFAULT;
  const counts = Array.from(
    { length: CAROUSEL_POSTS_MAX - CAROUSEL_POSTS_MIN + 1 },
    (_, i) => CAROUSEL_POSTS_MIN + i,
  );
  return (
    <fieldset className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <p className="text-xs text-muted-foreground">{t('intro')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span id="carousel-theme-label" className="text-sm">
            {t('theme')}
          </span>
          <SegmentedControl
            aria-labelledby="carousel-theme-label"
            className="self-start"
            value={theme}
            onChange={(key) => onChange({ carouselTheme: key })}
            options={THEMES.map((key) => ({
              value: key,
              label: (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      'size-3.5 rounded-full border border-border',
                      key === 'light' ? 'bg-white' : 'bg-black',
                    )}
                  />
                  {t(`themes.${key}`)}
                </>
              ),
            }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="carousel-posts" className="text-sm">
            {t('posts')}
          </label>
          <NativeSelect
            id="carousel-posts"
            value={posts}
            disabled={Boolean(state.carouselThread?.trim())}
            onChange={(e) => onChange({ carouselPosts: Number(e.target.value) })}
          >
            {counts.map((n) => (
              <option key={n} value={n}>
                {t('postsValue', { count: n })}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="carousel-thread" className="text-sm">
          {t('thread')}
        </label>
        <textarea
          id="carousel-thread"
          value={state.carouselThread ?? ''}
          maxLength={CAROUSEL_THREAD_MAX}
          rows={6}
          dir="auto"
          onChange={(e) => onChange({ carouselThread: e.target.value })}
          placeholder={t('threadPlaceholder')}
          aria-describedby="carousel-thread-hint"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
        />
        <p id="carousel-thread-hint" className="text-xs text-muted-foreground">
          {t('threadHint')}
        </p>
      </div>
    </fieldset>
  );
}

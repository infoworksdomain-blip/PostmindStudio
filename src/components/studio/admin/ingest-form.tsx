'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { Section } from '../primitives';
import { parseTags, type CategoryOption } from '../library/library-utils';
import type { IngestItem, IngestResponse, LicenseScenario } from './types';

// A3.8 bulk import — POST /admin/library/ingest with up to 100 source URLs sharing one licence
// scenario, category and tag set. Each URL becomes an ingest job (download → analyse → embed).

export const MAX_INGEST = 100;
const MAX_TAGS = 20;

const MAX_INVALID_SHOWN = 3;
const SCENARIOS = [
  { value: 'LICENSED', label: 'scenarioLicensed' },
  { value: 'OWNED', label: 'scenarioOwned' },
  { value: 'SCRAPED', label: 'scenarioScraped' },
  { value: 'NOT_REQUIRED', label: 'scenarioNotRequired' },
] as const satisfies ReadonlyArray<{ value: LicenseScenario; label: string }>;

export function parseUrls(text: string): { urls: string[]; invalid: string[] } {
  const lines = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of lines) {
    try {
      const url = new URL(line);
      if (url.protocol === 'https:' || url.protocol === 'http:') urls.push(line);
      else invalid.push(line);
    } catch {
      invalid.push(line);
    }
  }
  return { urls, invalid };
}

export function IngestForm({ categories }: { categories: CategoryOption[] }) {
  const t = useTranslations('admin.library.ingest');
  const errorMessage = useErrorMessage();
  const [text, setText] = useState('');
  const [scenario, setScenario] = useState<LicenseScenario>('LICENSED');
  const [licenseSource, setLicenseSource] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState<IngestResponse['queued']>([]);
  const { urls, invalid } = parseUrls(text);
  const tooMany = urls.length > MAX_INGEST;
  const tooManyTags = parseTags(tags).length > MAX_TAGS;
  const valid = urls.length > 0 && invalid.length === 0 && !tooMany && !tooManyTags;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || pending) return;
    const shared = {
      licenseScenario: scenario,
      tags: parseTags(tags),
      ...(licenseSource.trim() && { licenseSource: licenseSource.trim() }),
      ...(category && { category }),
    };
    const items: IngestItem[] = urls.map((sourceUrl) => ({ sourceUrl, ...shared }));
    setPending(true);
    try {
      const res = await api<IngestResponse>('/admin/library/ingest', {
        method: 'POST',
        body: { items },
        idempotencyKey: newIdempotencyKey(),
      });
      setQueued(res.queued);
      setText('');
      toast.success(t('queued', { count: res.queued.length }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Section title={t('title')} description={t('description', { max: MAX_INGEST })}>
      <form onSubmit={submit} aria-label={t('formAria')} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="ingest-urls">{t('urls')}</Label>
          <Textarea
            id="ingest-urls"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('urlsPlaceholder')}
            className="font-mono text-xs"
            aria-invalid={invalid.length > 0 || tooMany}
            aria-describedby="ingest-urls-hint"
          />
          <p id="ingest-urls-hint" className="text-xs text-muted-foreground">
            {invalid.length > 0
              ? t('invalid', {
                  urls:
                    invalid.slice(0, MAX_INVALID_SHOWN).join(', ') +
                    (invalid.length > MAX_INVALID_SHOWN ? '…' : ''),
                })
              : tooMany
                ? t('tooMany', { count: urls.length, max: MAX_INGEST })
                : t('ready', { count: urls.length })}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ingest-scenario">{t('licence')}</Label>
            <NativeSelect
              id="ingest-scenario"
              value={scenario}
              onChange={(e) => setScenario(e.target.value as LicenseScenario)}
            >
              {SCENARIOS.map((s) => (
                <option key={s.value} value={s.value}>
                  {t(s.label)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ingest-source">{t('source')}</Label>
            <Input
              id="ingest-source"
              value={licenseSource}
              onChange={(e) => setLicenseSource(e.target.value)}
              maxLength={500}
              placeholder={t('sourcePlaceholder')}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ingest-category">{t('category')}</Label>
            <NativeSelect
              id="ingest-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">{t('autoClassify')}</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {`${'  '.repeat(c.depth)}${c.label}`}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ingest-tags">{t('tags')}</Label>
            <Input
              id="ingest-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('tagsPlaceholder')}
              aria-invalid={tooManyTags}
            />
            {tooManyTags && (
              <p className="text-xs text-destructive">{t('tooManyTags', { max: MAX_TAGS })}</p>
            )}
          </div>
        </div>
        <div>
          <Button type="submit" disabled={!valid} loading={pending}>
            {t('submit', { count: urls.length })}
          </Button>
        </div>
      </form>
      {queued.length > 0 && (
        <div className="mt-5 border-t border-border/70 pt-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('lastBatch')}</h3>
          <ul aria-label={t('queuedAria')} className="grid gap-1 text-xs">
            {queued.map((q) => (
              <li key={q.jobId} className="flex min-w-0 justify-between gap-3">
                <span className="truncate font-mono">{q.sourceUrl}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {q.jobId.slice(0, 18)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

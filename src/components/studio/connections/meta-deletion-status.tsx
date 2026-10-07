import { CheckCircle2, CircleHelp } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { AuthWordmark } from '@/components/auth/auth-frame';

// Phase 18 §2.10 — Meta's data-deletion status page body (/meta/data-deletion?code=…). Meta
// requires "a human-readable explanation of the status of their request" behind the URL and
// confirmation code the callback returned. Studio deletes synchronously, so a valid code is
// always a completed request.
// 25.6: restyled in the calm status pattern of the sign-in screens (wordmark, a status mark, the
// H1, the facts, the confirmation code set apart).

export interface MetaDeletionStatusProps {
  code: string;
  status: { requestedAt: Date; connectionsDeleted: number } | null;
}

export function MetaDeletionStatus({ code, status }: MetaDeletionStatusProps) {
  const t = useTranslations('connections.dataDeletion');
  const format = useFormatter();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col bg-background px-4 pt-5 pb-12 sm:px-6">
      <div className="flex h-9 items-center">
        <AuthWordmark />
      </div>
      <main className="flex flex-1 flex-col justify-center gap-5 pt-12">
        <span
          aria-hidden
          className={
            status
              ? 'grid size-10 place-items-center rounded-full bg-success-soft text-success-foreground'
              : 'grid size-10 place-items-center rounded-full bg-surface-raised text-foreground-secondary'
          }
        >
          {status ? (
            <CheckCircle2 className="size-5" strokeWidth={1.75} />
          ) : (
            <CircleHelp className="size-5" strokeWidth={1.75} />
          )}
        </span>
        <div>
          <p className="text-[0.8125rem] font-medium text-foreground-secondary">{t('eyebrow')}</p>
          <h1 className="mt-2 font-display text-[1.75rem] leading-[1.15] text-balance sm:text-[2rem]">
            {t('title')}
          </h1>
        </div>
        {status ? (
          <section
            aria-labelledby="deletion-status"
            className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed"
          >
            <h2 id="deletion-status" className="font-medium text-success-foreground">
              {t('completed')}
            </h2>
            <p>
              {t('receivedOn', {
                date: format.dateTime(status.requestedAt, {
                  dateStyle: 'long',
                  timeStyle: 'short',
                }),
              })}
            </p>
            <p>{t('deletedCount', { count: status.connectionsDeleted })}</p>
            <p className="text-foreground-secondary">{t('whatWasDeleted')}</p>
            <p className="text-foreground-secondary">{t('retained')}</p>
            <p className="mt-2 rounded-field bg-surface-raised px-3.5 py-3 text-[0.8125rem] text-foreground-secondary">
              {t('codeLabel')} <bdi className="font-mono text-foreground">{code}</bdi>
            </p>
          </section>
        ) : (
          <p role="alert" className="text-[0.9375rem] leading-relaxed text-foreground-secondary">
            {t('unknownCode')}
          </p>
        )}
      </main>
    </div>
  );
}

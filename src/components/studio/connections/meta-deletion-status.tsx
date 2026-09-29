import { useFormatter, useTranslations } from 'next-intl';

// Phase 18 §2.10 — Meta's data-deletion status page body (/meta/data-deletion?code=…). Meta
// requires "a human-readable explanation of the status of their request" behind the URL and
// confirmation code the callback returned. Studio deletes synchronously, so a valid code is
// always a completed request.

export interface MetaDeletionStatusProps {
  code: string;
  status: { requestedAt: Date; connectionsDeleted: number } | null;
}

export function MetaDeletionStatus({ code, status }: MetaDeletionStatusProps) {
  const t = useTranslations('connections.dataDeletion');
  const format = useFormatter();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6 py-16">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{t('eyebrow')}</p>
      <h1 className="font-display text-4xl leading-tight">{t('title')}</h1>
      {status ? (
        <section aria-labelledby="deletion-status" className="flex flex-col gap-2 text-sm">
          <h2 id="deletion-status" className="font-medium">
            {t('completed')}
          </h2>
          <p>
            {t('receivedOn', {
              date: format.dateTime(status.requestedAt, { dateStyle: 'long', timeStyle: 'short' }),
            })}
          </p>
          <p>{t('deletedCount', { count: status.connectionsDeleted })}</p>
          <p className="text-muted-foreground">{t('whatWasDeleted')}</p>
          <p className="text-muted-foreground">{t('retained')}</p>
          <p className="text-xs text-muted-foreground">
            {t('codeLabel')} <bdi className="font-mono">{code}</bdi>
          </p>
        </section>
      ) : (
        <p role="alert" className="text-sm">
          {t('unknownCode')}
        </p>
      )}
    </main>
  );
}

'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authErrorKey, type AuthErrorKey } from '@/lib/client/auth';
import { cn } from '@/lib/utils';

// Phase 18 Track A, restyled in 25.6 — the content every sign-in screen shares: a clear H1 on the
// canvas (no card chrome; the frame gives the whitespace), helper text, the form, and a quiet
// footer of secondary links. One primary action per screen.

export function AuthCard({
  title,
  description,
  children,
  footer,
  icon,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** A small status mark above the title (success / problem states). */
  icon?: ReactNode;
}) {
  return (
    <section aria-labelledby="auth-title" className="w-full">
      {icon && <div className="mb-5">{icon}</div>}
      <h1
        id="auth-title"
        className="font-display text-[1.75rem] leading-[1.15] text-balance sm:text-[2rem]"
      >
        {title}
      </h1>
      {description && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-foreground-secondary">
          {description}
        </p>
      )}
      <div className="mt-8">{children}</div>
      {footer && (
        <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-5 text-sm text-foreground-secondary">
          {footer}
        </div>
      )}
    </section>
  );
}

/** A quiet secondary link in an AuthCard footer or under a form. */
export const authLinkClass =
  'rounded-control underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none';

/** A round status mark for AuthCard's `icon`: success (sent, changed) or problem (bad link). */
export function AuthStatusMark({ tone }: { tone: 'success' | 'problem' }) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-10 place-items-center rounded-full',
        tone === 'success'
          ? 'bg-success-soft text-success-foreground'
          : 'bg-surface-raised text-foreground-secondary',
      )}
    >
      <Icon className="size-5" strokeWidth={1.75} />
    </span>
  );
}

/** The form field an auth error belongs to (shown under that field), or null (shown on top). */
export type AuthField = 'email' | 'password' | 'code';

const FIELD_OF: Partial<Record<AuthErrorKey, AuthField>> = {
  invalidEmail: 'email',
  passwordTooShort: 'password',
  passwordTooLong: 'password',
  passwordCompromised: 'password',
  invalidCode: 'code',
};

export function authErrorField(error: unknown): AuthField | null {
  if (!error || typeof error === 'string') return null;
  return FIELD_OF[authErrorKey(error)] ?? null;
}

/** The translated message for an auth error (never the server's raw text), when it is not a
 *  field's own error (those show under the field: FieldError). */
export function AuthError({ error }: { error: unknown }) {
  const t = useTranslations('auth.errors');
  if (!error || authErrorField(error)) return null;
  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-2.5 rounded-field bg-destructive-soft px-3.5 py-3 text-sm text-destructive-foreground"
    >
      <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>{t(typeof error === 'string' ? 'generic' : authErrorKey(error))}</p>
    </div>
  );
}

/**
 * An inline error under a field, linked from the input with aria-describedby (and the input marked
 * aria-invalid by the caller). Announced when it appears, and the field takes focus so the person
 * lands where the fix is.
 */
export function FieldError({
  id,
  error,
  field,
  inputRef,
}: {
  id: string;
  error: unknown;
  field: AuthField;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations('auth.errors');
  const mine = authErrorField(error) === field;
  const focused = useRef<unknown>(null);
  useEffect(() => {
    if (mine && focused.current !== error) {
      focused.current = error;
      inputRef?.current?.focus();
    }
  }, [mine, error, inputRef]);
  if (!mine) return null;
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-1.5 text-[0.8125rem] text-destructive-foreground"
    >
      <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {t(authErrorKey(error))}
    </p>
  );
}

/** Props that link an input to its FieldError when the error is that field's. */
export function fieldErrorProps(error: unknown, field: AuthField, errorId: string) {
  return authErrorField(error) === field
    ? { 'aria-invalid': true as const, 'aria-describedby': errorId }
    : {};
}

export function AuthNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-2.5 rounded-field bg-success-soft px-3.5 py-3 text-sm text-success-foreground"
    >
      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

/**
 * Track B §2.8: mail to a suppressed (bounced / complained) address is never sent. The server
 * cannot say so without revealing whether an account exists, so every "check your inbox" screen
 * carries the support contact (when STUDIO_SUPPORT_EMAIL is set).
 */
export function SupportContact({ email }: { email?: string }) {
  const t = useTranslations('auth.support');
  if (!email) return null;
  return (
    <p className="mt-6 text-[0.8125rem] text-foreground-secondary">
      {t.rich('noEmail', {
        email,
        link: (chunks) => (
          <a className={cn(authLinkClass, 'underline')} href={`mailto:${email}`} dir="ltr">
            {chunks}
          </a>
        ),
      })}
    </p>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AuthError } from '@/components/auth/auth-card';
import { PASSWORD_MIN, PasswordField } from '@/components/auth/password-field';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/client/auth';
import { Section } from '../../primitives';

// Phase 18 §2.3 / §5.1 — change password. The server always signs out every other session.

export function PasswordSection() {
  const t = useTranslations('security.password');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await authFetch('/change-password', {
        body: { currentPassword: current, newPassword: next, revokeOtherSessions: true },
      });
      setCurrent('');
      setNext('');
      toast.success(t('changed'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('title')} description={t('description')}>
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="grid max-w-md gap-4">
        <PasswordField
          label={t('current')}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PasswordField
          label={t('new')}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          showStrength
        />
        <Button
          type="submit"
          className="justify-self-start"
          disabled={busy || current === '' || next.length < PASSWORD_MIN}
        >
          {busy && <Loader2 className="animate-spin" />}
          {t('submit')}
        </Button>
      </form>
    </Section>
  );
}

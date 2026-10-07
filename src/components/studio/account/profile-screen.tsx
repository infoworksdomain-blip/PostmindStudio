'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AuthError } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi, authFetch, type SessionPayload } from '@/lib/client/auth';
import { LOCALES } from '@/lib/i18n/locales';
import { PageHeader, Section } from '../primitives';
import { ThemeSwitcher } from '../theme-switcher';

// Phase 18 Track A — /account/profile: name, the language Studio emails you in, and email change
// (§5.5: the current address approves the change, the new one confirms it).

const LANGUAGE_NAMES: Record<string, string> = {
  'en-GB': 'English (UK)',
  'en-US': 'English (US)',
  fr: 'Français',
  es: 'Español',
  ar: 'العربية',
  de: 'Deutsch',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  hi: 'हिन्दी',
  'zh-Hans': '简体中文',
};

export function ProfileScreen() {
  const t = useTranslations('account.profile');
  const nameId = useId();
  const localeId = useId();
  const emailId = useId();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [name, setName] = useState('');
  const [locale, setLocale] = useState('en-GB');
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState<'profile' | 'email' | null>(null);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    void authApi.getSession().then((s) => {
      setSession(s);
      setName(s?.user.name ?? '');
      setLocale(s?.user.locale ?? 'en-GB');
    });
  }, []);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('profile');
    setError(undefined);
    try {
      await authFetch('/update-user', { body: { name: name.trim(), locale } });
      toast.success(t('saved'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const changeEmail = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('email');
    setError(undefined);
    try {
      await authFetch('/change-email', {
        body: { newEmail: newEmail.trim(), callbackURL: '/account/profile' },
      });
      setNewEmail('');
      toast.success(t('emailRequested'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
      <AuthError error={error} />
      <div className="space-y-6">
        <Section title={t('detailsTitle')}>
          <form onSubmit={(e) => void saveProfile(e)} className="grid max-w-md gap-4">
            <div className="space-y-2">
              <Label htmlFor={nameId}>{t('name')}</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={localeId}>{t('emailLanguage')}</Label>
              <select
                id={localeId}
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l} lang={l}>
                    {LANGUAGE_NAMES[l] ?? l}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t('emailLanguageHint')}</p>
            </div>
            <Button
              type="submit"
              className="justify-self-start"
              disabled={busy !== null || !name.trim()}
            >
              {busy === 'profile' && <Loader2 className="animate-spin" />}
              {t('save')}
            </Button>
          </form>
        </Section>
        <Section
          title={t('emailTitle')}
          description={session ? t('emailCurrent', { email: session.user.email }) : undefined}
        >
          <form onSubmit={(e) => void changeEmail(e)} className="grid max-w-md gap-4">
            <div className="space-y-2">
              <Label htmlFor={emailId}>{t('newEmail')}</Label>
              <Input
                id={emailId}
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                autoComplete="email"
                required
                className="h-10"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('emailHint')}</p>
            <Button
              type="submit"
              variant="outline"
              className="justify-self-start"
              disabled={busy !== null || !newEmail.includes('@')}
            >
              {busy === 'email' && <Loader2 className="animate-spin" />}
              {t('changeEmail')}
            </Button>
          </form>
        </Section>
        <Section title={t('appearanceTitle')} description={t('appearanceDescription')}>
          <ThemeSwitcher />
        </Section>
      </div>
    </div>
  );
}

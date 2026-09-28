'use client';

import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { isLocale, LOCALE_INFO, LOCALES } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { useLocaleSwitch } from './intl-provider';

// BACKLOG 16.1 — interface language switcher in the app-shell header. Radix Select gives the
// accessible pattern: a combobox trigger with a listbox of options (arrow keys, typeahead, Escape,
// focus return), mirrored by the DirectionProvider in RTL. Each option shows the language's own
// name and carries its `lang` so screen readers pronounce it correctly. The choice is stored in
// the studio.locale cookie (StudioIntlProvider.setLocale).

export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('shell.language');
  const { locale, setLocale } = useLocaleSwitch();
  const current = LOCALE_INFO[locale];
  return (
    <Select
      value={locale}
      onValueChange={(value) => {
        if (isLocale(value) && value !== locale) setLocale(value);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t('trigger', { language: current.label })}
        className={cn('border-transparent shadow-none hover:bg-accent', className)}
      >
        <Languages aria-hidden className="text-muted-foreground" />
        <span lang={current.code} className="hidden sm:inline">
          {current.label}
        </span>
      </SelectTrigger>
      <SelectContent position="popper" align="end" aria-label={t('label')}>
        {LOCALES.map((code) => {
          const info = LOCALE_INFO[code];
          return (
            <SelectItem key={code} value={code} lang={code} dir={info.dir}>
              {info.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

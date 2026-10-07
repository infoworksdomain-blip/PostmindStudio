'use client';

import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { isLocale, LOCALE_INFO, LOCALES } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils';
import { useLocaleSwitch } from './intl-provider';

// BACKLOG 16.1 — interface language switcher in the app-shell header. Radix Select gives the
// accessible pattern: a combobox trigger with a listbox of options (arrow keys, typeahead, Escape,
// focus return), mirrored by the DirectionProvider in RTL. Each option shows the language's own
// name and carries its `lang` so screen readers pronounce it correctly. The choice is stored in
// the studio.locale cookie (StudioIntlProvider.setLocale).

export function LanguageSwitcher({
  className,
  labelClassName = 'hidden sm:inline',
}: {
  className?: string;
  /** When the language name shows next to the icon (the app header hides it until xl). */
  labelClassName?: string;
}) {
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
        <span lang={current.code} className={labelClassName}>
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

/**
 * 25.4: the same choice inside a dropdown (the account menu): a sub-menu whose trigger names the
 * current language, with each language as a radio item in its own script and direction.
 */
export function LanguageMenuSub() {
  const t = useTranslations('shell.language');
  const { locale, setLocale } = useLocaleSwitch();
  const current = LOCALE_INFO[locale];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages aria-hidden className="text-muted-foreground" />
        <span>{t('label')}</span>
        <span lang={current.code} className="ms-auto ps-3 text-xs text-muted-foreground">
          {current.label}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-48 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value) && value !== locale) setLocale(value);
          }}
        >
          {LOCALES.map((code) => {
            const info = LOCALE_INFO[code];
            return (
              <DropdownMenuRadioItem key={code} value={code} lang={code} dir={info.dir}>
                {info.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

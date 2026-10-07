'use client';

import { useId } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useHydrated } from '@/lib/client/use-hydrated';
import { cn } from '@/lib/utils';

// BACKLOG 25.2 — Light / Dark / System. next-themes stores the choice in localStorage ("theme")
// and its inline script sets the class before paint (no flash; <html suppressHydrationWarning>).
// The server cannot know the saved choice, so every control renders "nothing chosen" until
// hydration has finished (useHydrated), then the real value (React error #418, 20.10).

export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const ICONS: Record<ThemeChoice, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

function isChoice(value: string | undefined): value is ThemeChoice {
  return (THEME_CHOICES as readonly string[]).includes(value ?? '');
}

/** The saved choice once hydrated (undefined before), and a setter. */
export function useThemeChoice(): {
  choice: ThemeChoice | undefined;
  setChoice: (choice: ThemeChoice) => void;
} {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();
  return { choice: hydrated && isChoice(theme) ? theme : undefined, setChoice: setTheme };
}

/** Segmented radio group (native radios: arrow keys move the choice, Tab leaves the group). */
export function ThemeSwitcher({ className }: { className?: string }) {
  const t = useTranslations('shell.theme');
  const name = useId();
  const { choice, setChoice } = useThemeChoice();
  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="sr-only">{t('label')}</legend>
      <div className="inline-flex gap-0.5 rounded-field border border-border bg-muted p-0.5">
        {THEME_CHOICES.map((value) => {
          const Icon = ICONS[value];
          return (
            <label
              key={value}
              className={cn(
                'relative inline-flex cursor-pointer items-center gap-1.5 rounded-control px-3 py-1.5 text-sm text-muted-foreground',
                'transition-colors duration-(--duration-fast) ease-standard select-none hover:text-foreground',
                'has-checked:bg-card has-checked:text-foreground has-checked:shadow-raised',
                'has-focus-visible:ring-2 has-focus-visible:ring-ring',
              )}
            >
              <input
                type="radio"
                name={name}
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className="sr-only"
              />
              <Icon aria-hidden className="size-4" />
              {t(value)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The same choice as menu radio items, for a dropdown (the account menu, the top bar). */
export function ThemeMenuRadioItems() {
  const t = useTranslations('shell.theme');
  const { choice, setChoice } = useThemeChoice();
  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">{t('label')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={choice ?? ''}
        onValueChange={(value) => {
          if (isChoice(value)) setChoice(value);
        }}
      >
        {THEME_CHOICES.map((value) => {
          const Icon = ICONS[value];
          return (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden /> {t(value)}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** Compact top-bar button: shows the current choice and opens the three options. */
export function ThemeMenuButton() {
  const t = useTranslations('shell.theme');
  const { choice } = useThemeChoice();
  const Icon = choice ? ICONS[choice] : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={choice ? t('current', { theme: t(choice) }) : t('label')}
        >
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeMenuRadioItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

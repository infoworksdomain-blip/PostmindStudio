'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { StatusPill } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { Page, Project } from '@/lib/client/types';
import { useProjectName } from '@/lib/client/use-project-name';
import { cn } from '@/lib/utils';
import { useBusiness } from '../business-context';
import type { BusinessesResponse } from '../business-picker';
import { THEME_CHOICES, useThemeChoice } from '../theme-switcher';
import {
  filterCommands,
  moveActive,
  PROJECT_SEARCH_DEBOUNCE_MS,
  PROJECT_SEARCH_LIMIT,
  PROJECT_SEARCH_MIN,
  type CommandEntry,
  type CommandGroup,
} from './command-model';
import { NAV } from './nav';
import { useShowStaff } from './use-show-staff';

// BACKLOG 25.4 — the command menu (⌘K / Ctrl+K, or the search button in the top bar). It lists
// only real things: every navigation destination, the create entry points that exist (/new,
// /templates, /plans/new), switching business, the appearance choice, and the organisation's
// projects found through GET /projects?q= (debounced, top 8, Enter opens the project).
// Accessibility: the text field is a combobox that owns a listbox; the active option is
// aria-activedescendant (focus stays in the field), arrows move it, Enter runs it, Escape closes
// the dialog and focus returns to the trigger; the result count is announced politely.

interface Entry extends CommandEntry {
  projectState?: string;
}

const GROUP_ORDER: readonly CommandGroup[] = [
  'projects',
  'navigate',
  'create',
  'business',
  'appearance',
];

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useStaticEntries(): Entry[] {
  const t = useTranslations('shell.command');
  const tn = useTranslations('shell.nav.items');
  const tg = useTranslations('shell.nav.groups');
  const tt = useTranslations('shell.theme');
  const showStaff = useShowStaff();
  const { businessId, setBusinessId, ready } = useBusiness();
  const { setChoice } = useThemeChoice();
  // The palette mounts only while the menu is open; the top bar has usually cached this list.
  const businesses = useApi<BusinessesResponse>(ready ? '/businesses' : null, undefined, {
    shouldRetryOnError: false,
  });
  return useMemo(() => {
    const nav: Entry[] = NAV.filter((n) => showStaff || n.group !== 'staff').map((n) => ({
      id: `nav:${n.href}`,
      group: 'navigate',
      label: tn(n.key),
      // The group name finds its pages too ("plan" lists Calendar, Month plans, …).
      keywords: n.group === 'home' ? undefined : tg(n.group),
      href: n.href,
    }));
    const account: Entry[] = [
      {
        id: 'nav:/account/profile',
        group: 'navigate',
        label: t('profile'),
        href: '/account/profile',
      },
      {
        id: 'nav:/account/export',
        group: 'navigate',
        label: tn('export'),
        href: '/account/export',
      },
    ];
    const create: Entry[] = [
      { id: 'create:new', group: 'create', label: t('createNew'), href: '/new' },
      { id: 'create:template', group: 'create', label: t('useTemplate'), href: '/templates' },
      { id: 'create:plan', group: 'create', label: t('planMonth'), href: '/plans/new' },
    ];
    const switching: Entry[] = (businesses.data?.data ?? [])
      .filter((b) => b.id !== businessId)
      .map((b) => ({
        id: `business:${b.id}`,
        group: 'business',
        label: t('switchBusiness', { name: b.name }),
        keywords: b.domain,
        run: () => setBusinessId(b.id),
      }));
    const appearance: Entry[] = THEME_CHOICES.map((choice) => ({
      id: `theme:${choice}`,
      group: 'appearance',
      label: t('theme', { theme: tt(choice) }),
      keywords: tt('label'),
      run: () => setChoice(choice),
    }));
    return [...nav, ...account, ...create, ...switching, ...appearance];
  }, [t, tn, tg, tt, showStaff, businesses.data, businessId, setBusinessId, setChoice]);
}

function useProjectEntries(query: string): {
  entries: Entry[];
  searching: boolean;
  failed: boolean;
} {
  const projectName = useProjectName();
  const text = useDebouncedValue(query.trim(), PROJECT_SEARCH_DEBOUNCE_MS);
  const enabled = text.length >= PROJECT_SEARCH_MIN;
  const { data, error, isLoading } = useApi<Page<Project>>(
    enabled ? '/projects' : null,
    { q: text, limit: PROJECT_SEARCH_LIMIT },
    { shouldRetryOnError: false, keepPreviousData: true },
  );
  const entries = useMemo<Entry[]>(
    () =>
      enabled
        ? (data?.data ?? []).slice(0, PROJECT_SEARCH_LIMIT).map((p) => ({
            id: `project:${p.id}`,
            group: 'projects',
            label: projectName(p.name),
            href: `/projects/${p.id}`,
            projectState: p.state,
          }))
        : [],
    [enabled, data, projectName],
  );
  const pending = query.trim() !== text && query.trim().length >= PROJECT_SEARCH_MIN;
  return { entries, searching: enabled && (isLoading || pending), failed: enabled && !!error };
}

function ProjectState({ state }: { state: string }) {
  const f = useFormat();
  const { label, tone } = f.projectState(state);
  return (
    <StatusPill tone={tone} size="sm">
      {label}
    </StatusPill>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useTranslations('shell.command');
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const statics = useStaticEntries();
  const projects = useProjectEntries(query);
  const results = useMemo(() => {
    const matched = [...projects.entries, ...filterCommands(statics, query)];
    return GROUP_ORDER.flatMap((g) => matched.filter((e) => e.group === g));
  }, [projects.entries, statics, query]);
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const activeEntry = activeIndex >= 0 ? results[activeIndex] : undefined;
  const optionId = (entry: Entry) => `${listId}-${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  useEffect(() => {
    if (!activeEntry) return;
    const el = document.getElementById(optionId(activeEntry));
    el?.scrollIntoView?.({ block: 'nearest' });
    // optionId depends only on listId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntry]);

  const runEntry = (entry: Entry) => {
    onClose();
    if (entry.href) router.push(entry.href);
    else entry.run?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      setActive(moveActive(activeIndex, results.length, e.key));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeEntry) runEntry(activeEntry);
    }
  };

  const groups = GROUP_ORDER.map((group) => ({
    group,
    entries: results.filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0);

  const status = projects.searching
    ? t('searching')
    : projects.failed
      ? t('searchFailed')
      : t('results', { count: results.length });

  return (
    <>
      <DialogTitle className="sr-only">{t('title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeEntry ? optionId(activeEntry) : undefined}
          aria-label={t('inputLabel')}
          placeholder={t('placeholder')}
          value={query}
          maxLength={200}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t('listLabel')}
        className="max-h-[min(60dvh,26rem)] overflow-y-auto p-2"
      >
        {groups.map(({ group, entries }) => (
          <div key={group} role="group" aria-labelledby={`${listId}-${group}`} className="pb-1">
            <p
              id={`${listId}-${group}`}
              className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-muted-foreground"
            >
              {t(`groups.${group}`)}
            </p>
            {entries.map((entry) => {
              const selected = entry === activeEntry;
              return (
                <div
                  key={entry.id}
                  id={optionId(entry)}
                  role="option"
                  aria-selected={selected}
                  data-href={entry.href}
                  onMouseMove={() => {
                    if (!selected) setActive(results.indexOf(entry));
                  }}
                  onClick={() => runEntry(entry)}
                  className={cn(
                    'flex h-9 cursor-pointer items-center gap-3 rounded-control px-2.5 text-sm',
                    selected ? 'bg-surface-active text-foreground' : 'text-foreground-secondary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.projectState && <ProjectState state={entry.projectState} />}
                </div>
              );
            })}
          </div>
        ))}
        {results.length === 0 && !projects.searching && (
          <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
            {t('empty', { query: query.trim() })}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span role="status" aria-live="polite">
          {status}
        </span>
        <span aria-hidden className="hidden sm:inline">
          {t('hint')}
        </span>
      </div>
    </>
  );
}

/** ⌘K on Apple platforms, Ctrl K elsewhere (decided after hydration; Ctrl K before). */
function useShortcutLabel(): string {
  const [apple, setApple] = useState(false);
  useEffect(() => {
    setApple(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);
  return apple ? '⌘K' : 'Ctrl K';
}

export function CommandMenu() {
  const t = useTranslations('shell.command');
  const [open, setOpen] = useState(false);
  const shortcut = useShortcutLabel();
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          // The visible text is the name (hidden on phones, where the icon stands alone).
          aria-label={t('triggerText')}
          aria-keyshortcuts="Control+K Meta+K"
          className="gap-2 text-muted-foreground max-md:size-9 max-md:px-0 md:min-w-52 md:justify-start md:border md:border-border md:bg-surface-raised/50"
        >
          <Search aria-hidden className="size-4" />
          <span className="hidden md:inline">{t('triggerText')}</span>
          <kbd
            aria-hidden
            className="ms-auto hidden rounded-[4px] border border-border bg-background px-1.5 font-mono text-[0.65rem] leading-5 md:inline"
          >
            {shortcut}
          </kbd>
        </Button>
      </DialogTrigger>
      <DialogContent
        size="md"
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:top-[18%] sm:translate-y-0 sm:p-0"
      >
        {open && <CommandPalette onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

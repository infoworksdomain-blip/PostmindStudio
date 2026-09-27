'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Accessible tab bar (WAI-ARIA tabs: arrow keys move between tabs, one tab stop).

export interface TabDef {
  key: string;
  label: string;
  badge?: ReactNode;
}

export function ReviewTabs({
  tabs,
  active,
  onChange,
  idPrefix = 'review',
}: {
  tabs: TabDef[];
  active: string;
  onChange: (key: string) => void;
  idPrefix?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent, index: number) {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (tab) {
      onChange(tab.key);
      refs.current[next]?.focus();
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Review sections"
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1"
    >
      {tabs.map((tab, i) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              selected
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  tab,
  idPrefix = 'review',
  children,
}: {
  tab: string;
  idPrefix?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tab}`}
      aria-labelledby={`${idPrefix}-tab-${tab}`}
      className="pt-6"
    >
      {children}
    </div>
  );
}

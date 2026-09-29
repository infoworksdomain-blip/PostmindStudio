import { cn } from '@/lib/utils';
import { useLocation } from '../router';

// Slim strip above the app: says plainly that this is a demo with fictional sample data, and
// links the four tour pages. Stays one line on phones (short labels, horizontal scroll).

const LINKS = [
  { href: '#/tour', path: '/tour', label: 'Tour', short: 'Tour' },
  { href: '#/tour/whats-new', path: '/tour/whats-new', label: 'What’s new', short: 'New' },
  { href: '#/tour/system', path: '/tour/system', label: 'Behind the scenes', short: 'Behind' },
  { href: '#/tour/not-built', path: '/tour/not-built', label: 'Not built yet', short: 'Not built' },
] as const;

export function DemoBar() {
  const { pathname } = useLocation();
  return (
    <div
      role="region"
      aria-label="Demo build"
      className="relative z-30 flex h-8 items-center gap-3 overflow-x-auto bg-foreground px-3 text-[0.72rem] whitespace-nowrap text-background md:px-5"
    >
      <p className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="size-1.5 shrink-0 animate-rec rounded-full bg-primary" />
        <span className="font-semibold tracking-wide">Demo build</span>
        <span className="hidden text-background/70 sm:inline">
          · sample data for Leeds Sourdough (fictional)
        </span>
      </p>
      <nav aria-label="Demo tour" className="ml-auto flex items-center gap-0.5">
        {LINKS.map((l) => {
          const active = pathname === l.path;
          return (
            <a
              key={l.href}
              href={l.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded px-2 py-1 transition-colors hover:bg-background/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                active
                  ? 'text-background underline decoration-primary decoration-2 underline-offset-4'
                  : 'text-background/75',
              )}
            >
              <span className="sm:hidden">{l.short}</span>
              <span className="hidden sm:inline">{l.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}

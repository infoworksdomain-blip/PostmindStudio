import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { navigate } from '../router';

// Stand-in for next/link in the demo bundle: same props the screens use, hash navigation.

type Href = string | { pathname?: string; query?: Record<string, string | number | undefined> };

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: Href;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean;
  children?: ReactNode;
}

export function hrefToString(href: Href): string {
  if (typeof href === 'string') return href;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(href.query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return `${href.pathname ?? '/'}${qs ? `?${qs}` : ''}`;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, replace, scroll: _scroll, prefetch: _prefetch, onClick, target, children, ...rest },
  ref,
) {
  const url = hrefToString(href);
  const external = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || external || target === '_blank') return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(url, { replace });
  };
  return (
    <a
      ref={ref}
      href={external ? url : `#${url}`}
      target={external ? '_blank' : target}
      rel={external ? 'noreferrer' : rest.rel}
      onClick={handle}
      {...rest}
    >
      {children}
    </a>
  );
});

export default Link;

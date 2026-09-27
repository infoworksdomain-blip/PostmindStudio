import { vi } from 'vitest';

// Replays queued responses and records every request, so adapter tests can assert the exact
// URL, method, headers and body sent to a provider.

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | Error | (() => Response);

export function fakeFetch(...replies: Reply[]) {
  const queue = [...replies];
  const requests: RecordedRequest[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        // leave as string
      }
    }
    requests.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: no reply queued for ${String(input)}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

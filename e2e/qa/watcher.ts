import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, type Response } from '@playwright/test';

// The sweep spec's error detection (e2e/sweep.spec.ts), shared by the QA specs: error banners,
// uncaught page errors, console errors from our code and 5xx / unexpected 4xx API answers.

const ERROR_TEXT = [
  /Couldn[’']t load this/,
  /Something went wrong/,
  /Application error/,
  /This page hit a problem/,
  /Internal Server Error/,
];

export interface Issue {
  page: string;
  kind: 'banner' | 'pageerror' | 'console' | 'http' | 'blank';
  detail: string;
}

export class Watcher {
  readonly issues: Issue[] = [];
  private current = '';
  /** `METHOD /path-regex` fragments whose 4xx answers are the behaviour under test. */
  private expected: Array<{ method?: string; url: RegExp; status: number[] }> = [];

  constructor(
    private readonly page: Page,
    private readonly shotsDir?: string,
  ) {
    page.on('pageerror', (e) =>
      this.issues.push({ page: this.current, kind: 'pageerror', detail: e.message }),
    );
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/Failed to load resource/.test(text)) return;
      // A <video> that cannot decode the stub's zero bytes is a media error, not an app error.
      if (/MEDIA_ELEMENT_ERROR|The element has no supported sources/i.test(text)) return;
      this.issues.push({ page: this.current, kind: 'console', detail: text.slice(0, 300) });
    });
    page.on('response', (r) => void this.onResponse(r));
  }

  /** An answer the test provokes on purpose (a 4xx refusal, or a 5xx when the queue is down). */
  expect4xx(url: RegExp, ...status: number[]): void {
    this.expected.push({ url, status });
  }

  label(name: string): void {
    this.current = name;
  }

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    const status = res.status();
    if (!url.includes('/api/') || status < 400) return;
    if (this.expected.some((e) => e.url.test(url) && e.status.includes(status))) return;
    const body = status >= 500 ? await res.text().catch(() => '') : '';
    this.issues.push({
      page: this.current,
      kind: 'http',
      detail:
        `${res.request().method()} ${new URL(url).pathname} -> ${status} ${body.slice(0, 200)}`.trim(),
    });
  }

  async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  }

  async visit(path: string): Promise<void> {
    this.current = path;
    await this.page.goto(path);
    await this.settle();
    await this.check(path);
  }

  async check(name = this.current): Promise<void> {
    const body = (
      await this.page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).trim();
    if (!body) this.issues.push({ page: name, kind: 'blank', detail: 'empty body' });
    for (const re of ERROR_TEXT) {
      if (re.test(body)) this.issues.push({ page: name, kind: 'banner', detail: String(re) });
    }
  }

  async shot(name: string): Promise<void> {
    if (!this.shotsDir) return;
    mkdirSync(this.shotsDir, { recursive: true });
    await this.page
      .screenshot({
        path: join(this.shotsDir, `${name.replace(/[^a-z0-9]+/gi, '_')}.png`),
        fullPage: true,
      })
      .catch(() => undefined);
  }
}

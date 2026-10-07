import type { Page } from '@playwright/test';

// BACKLOG 25.4 — appearance, language and feedback moved from the top bar into the account menu.
// These helpers find the menu by stable attributes (data-shell), so they work in any interface
// language (a test may switch to Arabic, then on to German).

/** Opens the account menu (the avatar button at the end of the top bar). */
export async function openAccountMenu(page: Page): Promise<void> {
  await page.locator('[data-shell="account-menu"]').first().click();
}

/** Light, Dark or System from the account menu (English interface). */
export async function chooseTheme(page: Page, theme: 'Light' | 'Dark' | 'System'): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitemradio', { name: theme }).click();
}

/** An interface language from the account menu's Language sub-menu, by its own name. */
export async function chooseLanguage(page: Page, language: RegExp): Promise<void> {
  await openAccountMenu(page);
  await page.locator('[data-shell="language-menu"]').click();
  await page.getByRole('menuitemradio', { name: language }).click();
}

/** The feedback dialog, opened from the account menu (English interface). */
export async function openFeedback(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Send feedback' }).click();
}

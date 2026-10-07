import { expect, type Page } from '@playwright/test';

// BACKLOG 25.4 — appearance, language and feedback moved from the top bar into the account menu.
// These helpers find the menu by stable attributes (data-shell), so they work in any interface
// language (a test may switch to Arabic, then on to German).
//
// Radix closes a menu with a short exit animation. A click on the trigger while the previous menu
// is still animating out is taken as a click outside that menu and closes the new one again, so
// each helper waits for the last menu to be gone and retries the opening until the menu shows.

const MENU_TIMEOUT = 15_000;

async function menusGone(page: Page): Promise<void> {
  await expect(page.locator('[role="menu"]')).toHaveCount(0, { timeout: MENU_TIMEOUT });
}

/** Opens the account menu (the avatar button at the end of the top bar). */
export async function openAccountMenu(page: Page): Promise<void> {
  await menusGone(page);
  const trigger = page.locator('[data-shell="account-menu"]:visible').first();
  await expect(async () => {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await expect(page.locator('[data-shell="language-menu"]')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: MENU_TIMEOUT });
}

/** Light, Dark or System from the account menu (English interface). */
export async function chooseTheme(page: Page, theme: 'Light' | 'Dark' | 'System'): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitemradio', { name: theme }).click();
  await menusGone(page);
}

/** An interface language from the account menu's Language sub-menu, by its own name. */
export async function chooseLanguage(page: Page, language: RegExp): Promise<void> {
  await openAccountMenu(page);
  const sub = page.locator('[data-shell="language-menu"]');
  const option = page.getByRole('menuitemradio', { name: language });
  await expect(async () => {
    // A click opens the sub-menu with a mouse; the keyboard (ArrowRight) is the fallback.
    if ((await sub.getAttribute('aria-expanded')) !== 'true') {
      await sub.click();
      if (!(await option.isVisible())) {
        await sub.focus();
        await page.keyboard.press(
          (await page.locator('html').getAttribute('dir')) === 'rtl' ? 'ArrowLeft' : 'ArrowRight',
        );
      }
    }
    await expect(option).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: MENU_TIMEOUT });
  await option.click();
  await menusGone(page);
}

/** The feedback dialog, opened from the account menu (English interface). */
export async function openFeedback(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Send feedback' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

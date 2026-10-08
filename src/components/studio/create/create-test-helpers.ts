import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Shared steps for the Create screen tests (25.7): the format rail is always visible, and every
// option beyond the brief sits behind one "More options" disclosure.

/** Picks a format on the rail by its name ("AI video", "Slideshow", …). */
export async function pickFormat(name: string | RegExp): Promise<void> {
  await userEvent.click(screen.getByRole('radio', { name }));
}

/** Opens "More options" (no-op when it is already open). */
export async function openMoreOptions(): Promise<void> {
  const toggle = screen.getByRole('button', { name: 'More options' });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
}

/** The action bar: the options summary, the allowance line and Generate. */
export function actionBar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>('[data-slot="create-action-bar"]');
  if (!bar) throw new Error('Create action bar not rendered');
  return bar;
}

import { expect, test } from '@playwright/test';
import { CREATOR, seedCreator } from './support';

/**
 * The app's own links live behind one control, not under every page.
 *
 * They were a footer rendered beneath everything, which put a donation ask under the reader's
 * work on every screen — and, on the donation page itself, a link to the page they were already
 * on. Both were reported from a playtest.
 */
test.describe('the More menu', () => {
  test.beforeEach(() => {
    seedCreator();
  });

  test('no donation ask sits under the page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Nothing in the page itself — it is behind the control, and only there.
    await expect(page.getByRole('link', { name: /support the developers/i })).toHaveCount(0);
  });

  test('the menu opens and leads to the support page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /more/i }).click();
    await page.getByRole('menuitem', { name: /support the developers/i }).click();

    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByRole('heading', { name: /support the developers/i })).toBeVisible();
  });

  test('it does not offer to take you to the page you are on', async ({ page }) => {
    // The reported bug: the donation page carried a link to the donation page.
    await page.goto('/support');
    await page.getByRole('button', { name: /more/i }).click();

    // Scoped to the menu: the page's own <h1> says the same words, and matching it would assert
    // nothing about the control.
    const menu = page.getByRole('menu', { name: /more/i });
    await expect(menu.getByRole('menuitem', { name: /support the developers/i })).toHaveCount(0);
    await expect(menu.getByText(/support the developers/i)).toHaveAttribute('aria-current', 'page');
  });

  test('the control is absent on a creator board', async ({ page }) => {
    // A donation ask on a creator's page competes with that creator's own Patreon ask, in front
    // of an audience that came for them.
    await page.goto(`/c/${CREATOR.slug}`);
    await expect(page.getByRole('heading', { name: CREATOR.displayName })).toBeVisible();

    await expect(page.getByRole('button', { name: /more/i })).toHaveCount(0);
  });
});

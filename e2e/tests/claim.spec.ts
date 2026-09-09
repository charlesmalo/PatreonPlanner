import { expect, test } from '@playwright/test';
import { resetRateLimits, seed, setPatreonIdentity } from './support';

/**
 * Creating a board, through the real stack.
 *
 * This journey has never been possible from the app. `POST /creators/claim` has existed since the
 * beginning and nothing called it, so every board in this project was made by SQL or by a test —
 * in production the product had no front door for creators at all.
 */
test.beforeEach(() => {
  resetRateLimits();
  // The campaigns these tests claim, so a re-run does not meet its own boards and read 409.
  seed(`DELETE FROM "Creator" WHERE "patreonCampaignId" LIKE 'e2e-claim-%';`);
});

async function signIn(
  page: import('@playwright/test').Page,
  id: string,
  campaigns: Array<{ campaignId: string; displayName: string }>,
) {
  await setPatreonIdentity({ id, fullName: 'Ada Lovelace', memberships: [], campaigns });
  await page.goto('/');
  await page.getByRole('link', { name: /sign in with patreon/i }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
}

test('a creator signs in and makes a board from their campaign', async ({ page }) => {
  await signIn(page, 'claim-e2e-owner', [
    { campaignId: 'e2e-claim-one', displayName: 'Ada Makes Things' },
  ]);

  // The way in has to be findable. A front door nothing links to is the same defect again.
  await page.getByRole('link', { name: /create a board for it/i }).click();
  await expect(page).toHaveURL(/\/claim$/);

  await expect(page.getByText('Ada Makes Things')).toBeVisible();
  await page.getByRole('button', { name: 'Create the board for Ada Makes Things' }).click();

  // Lands on the board it just made, owning it.
  await expect(page).toHaveURL(/\/c\/ada-makes-things$/);
  await expect(page.getByRole('heading', { name: 'Ada Makes Things' })).toBeVisible();
  // Owner-only controls, which is the proof the staff row was created rather than just the board.
  await expect(page.getByRole('link', { name: /moderators/i })).toBeVisible();
});

test('a board it already made is a link to it, not an offer to make it again', async ({ page }) => {
  await signIn(page, 'claim-e2e-repeat', [
    { campaignId: 'e2e-claim-two', displayName: 'Ada Repeats' },
  ]);
  await page.goto('/claim');
  await page.getByRole('button', { name: 'Create the board for Ada Repeats' }).click();
  await expect(page).toHaveURL(/\/c\/ada-repeats$/);

  await page.goto('/claim');

  // Pressing claim again answers 409. Sending them to the board is the answer they wanted.
  await expect(page.getByRole('link', { name: 'Ada Repeats' })).toHaveAttribute(
    'href',
    '/c/ada-repeats',
  );
  await expect(page.getByRole('button', { name: 'Create the board for Ada Repeats' })).toHaveCount(
    0,
  );
});

test('a reader who runs no campaign is told so plainly', async ({ page }) => {
  await signIn(page, 'claim-e2e-nobody', []);
  await page.goto('/claim');

  await expect(page.getByText(/lists no campaigns for this account/i)).toBeVisible();
});

test('a new board starts private, and says so before it is made', async ({ page }) => {
  // The default exists because a readable board is a list of what a creator is watching. The
  // page says it beforehand; this checks the board actually is that.
  await signIn(page, 'claim-e2e-private', [
    { campaignId: 'e2e-claim-three', displayName: 'Ada Stays Quiet' },
  ]);
  await page.goto('/claim');
  await expect(page.getByText(/only your supporters/i)).toBeVisible();
  await page.getByRole('button', { name: 'Create the board for Ada Stays Quiet' }).click();
  await expect(page).toHaveURL(/\/c\/ada-stays-quiet$/);

  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto('/c/ada-stays-quiet');

  await expect(page.getByText(/sign in to see this board/i)).toBeVisible();
});
